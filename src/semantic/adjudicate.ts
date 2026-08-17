
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

import { relative } from "../discovery/layers.js";
import { resolveProvider, type Adjudication, type Provider } from "./providers.js";
import { SEVERITY } from "../rules/context.js";
import type { Diagnostic, MemoryRule } from "../model/types.js";

export interface SemanticOptions {
  apiKey?: string | undefined;
  model?: string;
  /** anthropic (default), or a shorthand like gemini / ollama / openrouter. */
  provider?: string | undefined;
  /** Explicit endpoint, for an OpenAI-compatible server not in the shorthand list. */
  baseUrl?: string | undefined;
  /** Hard ceiling on adjudications per run, so a huge repo can't surprise anyone. */
  maxPairs?: number;
  cacheDir?: string;
  projectRoot: string;
}

export type Verdict = Adjudication["verdict"];

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
  private readonly client: Provider | undefined;
  private readonly model: string;
  private readonly maxPairs: number;
  private readonly cacheFile: string;
  private cache: Record<string, Adjudication>;
  private dirty = false;

  /** Populated when we could not run at all, so the CLI can say why. */
  public unavailableReason: string | undefined;
  /** Which provider and model actually judged, e.g. `gemini...:gemini-2.0-flash`. */
  public get label(): string {
    return this.model;
  }
  public adjudicated = 0;
  public cacheHits = 0;
  /** Calls that returned something we could not read a verdict out of. */
  private unreadable = 0;
  /** Set on the first hard transport failure, e.g. a rate limit. */
  private aborted = false;
  /** Pairs never looked at because the run stopped early. */
  public unexamined = 0;

  constructor(private readonly options: SemanticOptions) {
    const resolved = resolveProvider({
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
    });
    // The cache key includes the provider label, so verdicts from a small local
    // model never masquerade as verdicts from a frontier one.
    this.model = resolved.provider?.label ?? resolved.config.model;
    this.maxPairs = options.maxPairs ?? 40;
    this.cacheFile = join(options.cacheDir ?? defaultCacheDir(), "semantic.json");
    this.cache = readCache(this.cacheFile);
    this.client = resolved.provider;
    if (resolved.unavailable) this.unavailableReason = resolved.unavailable;
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

    // A rule duplicated across three files yields three identical conflicts
    // against the same counterpart. Users read that as three problems.
    const reported = new Set<string>();

    for (const pair of budgeted) {
      // Once the endpoint has hard-failed — a rate limit is the common case on
      // free tiers — every remaining call will fail the same way. Firing them
      // anyway wastes the user's time and quota for no information.
      if (this.aborted) {
        this.unexamined++;
        continue;
      }

      const verdict = await this.adjudicate(pair);
      if (!verdict || verdict.verdict !== "conflict") continue;

      const pairKey = [pair.a.normalized, pair.b.normalized].sort().join("|");
      if (reported.has(pairKey)) continue;
      reported.add(pairKey);

      out.push({
        ruleId: "semantic/rule-conflict",
        severity: SEVERITY.environmental,
        heuristic: true,
        message: verdict.reasoning
          ? `Conflicting instructions: ${verdict.reasoning}`
          : "Conflicting instructions (the judge gave no reason).",
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

    if (this.adjudicated === 0 && this.unreadable > 0 && !this.unavailableReason) {
      this.unavailableReason =
        `${this.unreadable} response(s) from ${this.model} carried no readable verdict — ` +
        "the model may not follow the JSON schema. Try a larger model.";
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
      const parsed = await this.client.judge({
        system: SYSTEM,
        prompt,
        schema: RESULT_SCHEMA as unknown as Record<string, unknown>,
      });
      if (!parsed) {
        // A response we cannot parse is not the same as "no conflict". Counting
        // it lets the summary explain a zero instead of implying every pair was
        // judged and found compatible — silent under-reporting is the failure
        // mode this whole tool is built to avoid.
        this.unreadable++;
        return undefined;
      }

      this.cache[key] = parsed;
      this.dirty = true;
      this.adjudicated++;
      return parsed;
    } catch (error) {
      this.aborted = true;
      this.unavailableReason = `Semantic pass stopped: ${
        error instanceof Error ? error.message.slice(0, 160) : String(error)
      }`;
      return undefined;
    }
  }

  private flush(): void {
    if (!this.dirty) return;
    try {
      /**
       * Owner-only, because this file holds the rule text from your CLAUDE.md
       * next to each verdict. Under `node_modules/.cache` that hardly matters,
       * but the fallback is `os.tmpdir()/cclint` — shared on a multi-user
       * machine — and that is exactly where a GLOBAL install linting a non-Node
       * project writes. Default modes there let another account read your
       * instructions.
       *
       * The mode is a no-op on Windows, which has no POSIX bits. It costs
       * nothing and is correct everywhere else.
       */
      mkdirSync(dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.cacheFile, JSON.stringify(this.cache), {
        encoding: "utf8",
        mode: 0o600,
      });
      this.dirty = false;
    } catch {
      // A non-writable cache is not a lint failure.
    }
  }
}

/** Order-independent, so swapping A and B reuses the same cached verdict. */
function cacheKey(model: string, pair: CandidatePair): string {
  const [x, y] = [pair.a.normalized, pair.b.normalized].sort();
  return createHash("sha256").update(`${model}\u0000${x}\u0000${y}`).digest("hex").slice(0, 32);
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
