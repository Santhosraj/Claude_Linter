/**
 * Token counting.
 *
 * Two modes, and the tool always says which one it used:
 *
 *   exact     — POST /v1/messages/count_tokens. This is a lightweight counting
 *               endpoint, not an inference call. Counts are MODEL-SPECIFIC, so
 *               the model id is part of the cache key.
 *   estimated — offline character heuristic. Always rendered with a `~` and the
 *               word "estimated". Never print an estimate as if it were exact:
 *               the first power user to check our arithmetic is the one who
 *               decides whether the tool is trustworthy.
 *
 * We deliberately do not ship a GPT tokenizer (tiktoken and friends). It is the
 * wrong BPE for Claude and is off by roughly 15-20% on prose, worse on the
 * code-and-markdown mix that CLAUDE.md actually contains.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";

export type CountMode = "exact" | "estimated";

export interface TokenCount {
  tokens: number;
  mode: CountMode;
}

export interface CounterOptions {
  apiKey?: string | undefined;
  model?: string;
  /** Disable the network path entirely (CI without secrets, --offline). */
  offline?: boolean;
  cacheDir?: string;
}

const DEFAULT_MODEL = "claude-opus-5";

/**
 * Characters per token for the offline estimate.
 *
 * Calibrated against markdown-with-code, which is what config files are. Prose
 * alone runs leaner (~4.0) and dense code runs heavier (~3.0); 3.6 keeps the
 * estimate within a useful band for both without pretending to precision.
 */
const CHARS_PER_TOKEN = 3.6;

export class TokenCounter {
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly offline: boolean;
  private readonly memo = new Map<string, number>();
  private readonly cacheFile: string;
  private diskCache: Record<string, number>;
  private dirty = false;
  private client: Anthropic | undefined;
  /** Set once the API has failed, so we degrade instead of retrying per file. */
  private apiDisabled = false;
  private apiFailureReason: string | undefined;

  constructor(options: CounterOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    this.offline = options.offline === true || !this.apiKey;
    this.cacheFile = join(options.cacheDir ?? defaultCacheDir(), "tokens.json");
    this.diskCache = readCache(this.cacheFile);
  }

  get mode(): CountMode {
    return this.offline || this.apiDisabled ? "estimated" : "exact";
  }

  /** Why we fell back, if we did — surfaced in the report footer. */
  get degradedReason(): string | undefined {
    if (this.apiFailureReason) return this.apiFailureReason;
    if (this.offline && !this.apiKey) {
      return "ANTHROPIC_API_KEY not set — counts are offline estimates.";
    }
    if (this.offline) return "Running with --offline — counts are estimates.";
    return undefined;
  }

  async count(text: string): Promise<TokenCount> {
    if (text.length === 0) return { tokens: 0, mode: this.mode };

    const key = `${this.model}:${sha(text)}`;

    const memo = this.memo.get(key);
    if (memo !== undefined) return { tokens: memo, mode: this.mode };

    const cached = this.diskCache[key];
    if (cached !== undefined) {
      this.memo.set(key, cached);
      return { tokens: cached, mode: "exact" };
    }

    if (this.offline || this.apiDisabled) {
      return { tokens: estimate(text), mode: "estimated" };
    }

    try {
      const tokens = await this.callApi(text);
      this.memo.set(key, tokens);
      this.diskCache[key] = tokens;
      this.dirty = true;
      return { tokens, mode: "exact" };
    } catch (error) {
      // One failure disables the API for the rest of the run. A linter must
      // never hang a CI job retrying a dead endpoint file-by-file.
      this.apiDisabled = true;
      this.apiFailureReason = `Token API unavailable (${describeError(error)}) — fell back to estimates.`;
      return { tokens: estimate(text), mode: "estimated" };
    }
  }

  private async callApi(text: string): Promise<number> {
    this.client ??= new Anthropic({ apiKey: this.apiKey!, timeout: 15_000 });
    const result = await this.client.messages.countTokens({
      model: this.model,
      messages: [{ role: "user", content: text }],
    });
    return result.input_tokens;
  }

  flush(): void {
    if (!this.dirty) return;
    try {
      // Owner-only, for the same reason as the semantic cache: the fallback
      // location is the shared `os.tmpdir()/cclint`. This file holds content
      // hashes and counts rather than rule text, so the exposure is smaller —
      // but it is the same directory and the same one-word fix.
      mkdirSync(dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.cacheFile, JSON.stringify(this.diskCache), {
        encoding: "utf8",
        mode: 0o600,
      });
      this.dirty = false;
    } catch {
      // A non-writable cache directory is not a lint failure.
    }
  }
}

export function estimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function defaultCacheDir(): string {
  const local = join(process.cwd(), "node_modules", ".cache", "cclint");
  if (existsSync(join(process.cwd(), "node_modules"))) return local;
  return join(tmpdir(), "cclint");
}

function readCache(file: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
  } catch {
    // Missing or corrupt cache is fine — we just recount.
  }
  return {};
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "timed out" : error.message.slice(0, 120);
  }
  return String(error).slice(0, 120);
}
