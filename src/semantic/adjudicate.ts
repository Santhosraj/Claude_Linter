/**
 * Optional semantic adjudication.
 *
 * Design contract, and the reason this file is a *shell* rather than the core:
 *
 *   1. The deterministic core never calls this. A default `cclint` run is
 *      fully offline, free, and fast. This is opt-in via `--semantic`.
 *   2. It only ever sees CANDIDATE PAIRS chosen by the deterministic prefilter,
 *      never the whole corpus. Twenty pairs of two sentences each is a handful
 *      of tiny requests, not a bill.
 *   3. Every verdict is cached by content hash, so re-running in CI on an
 *      unchanged repo costs nothing.
 *   4. The schema has an explicit `insufficient_evidence` verdict. Without an
 *      escape hatch a judge will invent conflicts to seem useful, which is the
 *      exact false-positive problem the whole precision strategy exists to
 *      avoid.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { relative } from "../discovery/layers.js";
import { SEVERITY } from "../rules/context.js";
import type { Diagnostic, MemoryRule } from "../model/types.js";

export interface SemanticOptions {
  apiKey?: string | undefined;
  model?: string;
  /** Hard ceiling on adjudications per run, so a huge repo can't surprise anyone. */
  maxPairs?: number;
  cacheDir?: string;
  projectRoot: string;
}

export type Verdict = "conflict" | "compatible" | "insufficient_evidence";

interface Adjudication {
  verdict: Verdict;
  /** One sentence. Rendered verbatim in the finding. */
  reasoning: string;
  /** How the two rules would diverge in practice. Empty unless `conflict`. */
  divergence: string;
}

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["conflict", "compatible", "insufficient_evidence"],
      description:
        "conflict = following one rule necessarily violates the other. " +
        "compatible = both can be followed at once, including when one merely refines the other. " +
        "insufficient_evidence = the rules are about different topics, or you cannot tell without more context.",
    },
    reasoning: {
      type: "string",
      description: "One sentence justifying the verdict.",
    },
    divergence: {
      type: "string",
      description:
        "If verdict is conflict, one concrete situation where the two rules demand different actions. Empty string otherwise.",
    },
  },
  required: ["verdict", "reasoning", "divergence"],
  additionalProperties: false,
} as const;

const SYSTEM = `You judge whether two instructions from a coding agent's configuration files genuinely contradict each other.

Both instructions are live at the same time: they come from CLAUDE.md files that are all loaded into the model's context simultaneously, so neither overrides the other.

Answer "conflict" only when following one instruction would necessarily mean violating the other. Be strict about this.

Answer "compatible" when both can hold at once. This includes: one rule refining or scoping the other, rules about different situations, and rules that merely sound similar.

Answer "insufficient_evidence" when the rules address different topics, or when you would need to know more about the project to decide. Prefer this over guessing — a wrong "conflict" verdict is far more costly to the user than an abstention, because it sends them looking for a problem that does not exist.`;

export interface CandidatePair {
  a: MemoryRule;
  b: MemoryRule;
  /** Why the prefilter surfaced this pair — included in the prompt as context. */
  reason: string;
}

export class SemanticAdjudicator {
  private readonly client: Anthropic | undefined;
  private readonly model: string;
  private readonly maxPairs: number;
  private readonly cacheFile: string;
  private cache: Record<string, Adjudication>;
  private dirty = false;

  /** Populated when we could not run at all, so the CLI can say why. */
  public unavailableReason: string | undefined;
  public adjudicated = 0;
  public cacheHits = 0;

  constructor(private readonly options: SemanticOptions) {
    const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    this.model = options.model ?? "claude-opus-5";
    this.maxPairs = options.maxPairs ?? 40;
    this.cacheFile = join(options.cacheDir ?? defaultCacheDir(), "semantic.json");
    this.cache = readCache(this.cacheFile);

    if (!apiKey) {
      this.client = undefined;
      this.unavailableReason =
        "ANTHROPIC_API_KEY is not set — semantic adjudication was skipped.";
    } else {
      this.client = new Anthropic({ apiKey });
    }
  }

  async run(pairs: CandidatePair[]): Promise<Diagnostic[]> {
    if (pairs.length === 0) return [];

    const out: Diagnostic[] = [];
    const budgeted = pairs.slice(0, this.maxPairs);

    if (pairs.length > budgeted.length) {
      // Never silently truncate. A capped run that reads as a complete run is
      // how a linter quietly under-reports.
      out.push({
        ruleId: "semantic/truncated",
        severity: SEVERITY.environmental,
        message:
          `Semantic pass examined ${budgeted.length} of ${pairs.length} candidate rule pairs ` +
          `(--semantic-max-pairs).`,
        file: this.options.projectRoot,
        detail: ["Raise the cap to examine the remainder."],
      });
    }

    for (const pair of budgeted) {
      const verdict = await this.adjudicate(pair);
      if (!verdict || verdict.verdict !== "conflict") continue;

      out.push({
        ruleId: "semantic/rule-conflict",
        severity: SEVERITY.environmental,
        heuristic: true,
        message: `Conflicting instructions: ${verdict.reasoning}`,
        file: pair.b.file,
        position: pair.b.position,
        detail: [
          `${relative(this.options.projectRoot, pair.a.file)}:${pair.a.position.line} — ${pair.a.text}`,
          `${relative(this.options.projectRoot, pair.b.file)}:${pair.b.position.line} — ${pair.b.text}`,
          verdict.divergence ? `Diverges when: ${verdict.divergence}` : "",
          "Both files are in context simultaneously; neither overrides the other.",
          `Judged by ${this.model}.`,
        ].filter(Boolean),
        data: { verdict: verdict.verdict, model: this.model },
      });
    }

    this.flush();
    return out;
  }

  private async adjudicate(pair: CandidatePair): Promise<Adjudication | undefined> {
    const key = cacheKey(this.model, pair);
    const cached = this.cache[key];
    if (cached) {
      this.cacheHits++;
      return cached;
    }
    if (!this.client) return undefined;

    const prompt = [
      `Rule A (from ${relative(this.options.projectRoot, pair.a.file)}${pair.a.headings.length ? `, under "${pair.a.headings.join(" / ")}"` : ""}):`,
      pair.a.text,
      "",
      `Rule B (from ${relative(this.options.projectRoot, pair.b.file)}${pair.b.headings.length ? `, under "${pair.b.headings.join(" / ")}"` : ""}):`,
      pair.b.text,
      "",
      `A keyword prefilter surfaced this pair because: ${pair.reason}`,
      "The prefilter is lexical and frequently wrong — judge the rules on their meaning, not on why they were surfaced.",
    ].join("\n");

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: SYSTEM,
        // A scoped pairwise classification — low effort is the right tier here,
        // and keeps the opt-in pass genuinely cheap.
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: RESULT_SCHEMA },
        },
        messages: [{ role: "user", content: prompt }],
      });

      // Check stop_reason before touching content: a refusal returns HTTP 200
      // with empty or partial content, and indexing content[0] would throw.
      if (response.stop_reason === "refusal") {
        this.unavailableReason = "The model declined to judge one or more rule pairs.";
        return undefined;
      }

      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") return undefined;

      const parsed = JSON.parse(text.text) as Adjudication;
      if (!isAdjudication(parsed)) return undefined;

      this.cache[key] = parsed;
      this.dirty = true;
      this.adjudicated++;
      return parsed;
    } catch (error) {
      this.unavailableReason = `Semantic pass failed: ${
        error instanceof Error ? error.message.slice(0, 160) : String(error)
      }`;
      return undefined;
    }
  }

  private flush(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(this.cache), "utf8");
      this.dirty = false;
    } catch {
      // A non-writable cache is not a lint failure.
    }
  }
}

function isAdjudication(v: unknown): v is Adjudication {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (o["verdict"] === "conflict" ||
      o["verdict"] === "compatible" ||
      o["verdict"] === "insufficient_evidence") &&
    typeof o["reasoning"] === "string" &&
    typeof o["divergence"] === "string"
  );
}

/** Order-independent, so swapping A and B reuses the same cached verdict. */
function cacheKey(model: string, pair: CandidatePair): string {
  const [x, y] = [pair.a.normalized, pair.b.normalized].sort();
  return createHash("sha256").update(`${model} ${x} ${y}`).digest("hex").slice(0, 32);
}

function defaultCacheDir(): string {
  const local = join(process.cwd(), "node_modules", ".cache", "cclint");
  if (existsSync(join(process.cwd(), "node_modules"))) return local;
  return join(tmpdir(), "cclint");
}

function readCache(file: string): Record<string, Adjudication> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, Adjudication>;
    }
  } catch {
    // Missing or corrupt cache — just re-adjudicate.
  }
  return {};
}
