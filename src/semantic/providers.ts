/**
 * Model providers for the optional semantic pass.
 *
 * The deterministic core never touches any of this. Only `--semantic` does.
 *
 * Two implementations:
 *
 *   anthropic          the default, unchanged — uses the official SDK and
 *                      Claude's structured-output support.
 *   openai-compatible  plain fetch against any `/chat/completions` endpoint.
 *                      One adapter covers Gemini (which publishes an
 *                      OpenAI-compatible surface), Ollama, OpenRouter, Groq and
 *                      local servers, so adding a provider is a base URL rather
 *                      than a new code path to maintain.
 *
 * Keeping these behind one interface matters for a specific reason: the
 * adjudicator's value comes from its *abstention* behaviour, and that lives in
 * the prompt and the schema, not the transport. Both providers get the same
 * system prompt and the same three-way verdict, so swapping providers changes
 * who is judging, not what is being asked.
 */

import Anthropic from "@anthropic-ai/sdk";

export type ProviderKind = "anthropic" | "openai-compatible";

export interface Adjudication {
  verdict: "conflict" | "compatible" | "insufficient_evidence";
  reasoning: string;
  divergence: string;
}

export interface ProviderConfig {
  kind: ProviderKind;
  model: string;
  apiKey: string | undefined;
  /** Required for openai-compatible; ignored by the anthropic provider. */
  baseUrl?: string | undefined;
}

export interface JudgeRequest {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
}

export interface Provider {
  readonly label: string;
  judge(request: JudgeRequest): Promise<Adjudication | undefined>;
}

/** Well-known base URLs, so `--semantic-provider gemini` needs no extra flags. */
export const KNOWN_BASE_URLS: Record<string, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  ollama: "http://localhost:11434/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
};

/** Env var checked for each shorthand, in addition to the generic one. */
export const KNOWN_KEY_ENV: Record<string, string[]> = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  // Ollama is local and unauthenticated; a placeholder keeps the OpenAI client
  // shape happy without implying a credential is needed.
  ollama: [],
};

export class AnthropicProvider implements Provider {
  readonly label: string;
  private readonly client: Anthropic;

  constructor(private readonly config: ProviderConfig) {
    this.label = `anthropic:${config.model}`;
    this.client = new Anthropic({ apiKey: config.apiKey! });
  }

  async judge(request: JudgeRequest): Promise<Adjudication | undefined> {
    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: 4096,
      system: request.system,
      // A scoped pairwise classification — low effort is the right tier here,
      // and keeps the opt-in pass genuinely cheap.
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: request.schema },
      },
      messages: [{ role: "user", content: request.prompt }],
    });

    // Check stop_reason before touching content: a refusal returns HTTP 200
    // with empty or partial content, and indexing content[0] would throw.
    if (response.stop_reason === "refusal") return undefined;

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return undefined;
    return coerceAdjudication(text.text);
  }
}

export class OpenAICompatibleProvider implements Provider {
  readonly label: string;

  constructor(private readonly config: ProviderConfig) {
    this.label = `${config.baseUrl ?? "openai-compatible"}:${config.model}`;
  }

  async judge(request: JudgeRequest): Promise<Adjudication | undefined> {
    const base = (this.config.baseUrl ?? "").replace(/\/+$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.config.apiKey) headers["authorization"] = `Bearer ${this.config.apiKey}`;

      // The schema must go in the PROMPT here, not just in `response_format`.
      // The Anthropic path passes it structurally, so the model is told the
      // exact field names; `{"type":"json_object"}` only says "emit some JSON".
      // Without this, Gemini returned a valid verdict with `reasoning` and
      // `divergence` missing entirely, and findings rendered as
      // "Conflicting instructions:" followed by nothing.
      const system = `${request.system}\n\n${schemaInstruction(request.schema)}`;

      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: request.prompt },
          ],
          // Ask for JSON, but do not depend on it. Support for
          // `json_schema` varies across compatible servers, and a request that
          // errors because the server does not know the field is worse than one
          // that returns slightly untidy JSON we can still parse.
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} ${body.slice(0, 200)}`);
      }

      const json = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") return undefined;
      return coerceAdjudication(content);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Spell the required JSON shape out for servers that cannot take a schema. */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    "Reply with a single JSON object and nothing else. No prose, no markdown fences.",
    "It must have exactly these keys:",
    '  "verdict"    — one of "conflict", "compatible", "insufficient_evidence"',
    '  "reasoning"  — one sentence justifying the verdict (never empty)',
    '  "divergence" — if conflict, one concrete situation where the two rules',
    '                 demand different actions; otherwise an empty string',
    "",
    "JSON Schema:",
    JSON.stringify(schema),
  ].join("\n");
}

/**
 * Parse a verdict out of whatever the model actually returned.
 *
 * Deliberately tolerant on FORM and strict on CONTENT. Smaller and non-Anthropic
 * models routinely wrap JSON in ```json fences or add a sentence of preamble, and
 * rejecting those would make the pass look broken when the judgement was fine.
 * But an unrecognised verdict string is never coerced into a guess — it returns
 * undefined, which the caller treats as "no opinion" rather than "compatible".
 */
export function coerceAdjudication(raw: string): Adjudication | undefined {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  candidates.push(trimmed);

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const o = parsed as Record<string, unknown>;

    const verdict = typeof o["verdict"] === "string" ? o["verdict"].toLowerCase().trim() : "";
    if (
      verdict !== "conflict" &&
      verdict !== "compatible" &&
      verdict !== "insufficient_evidence"
    ) {
      continue;
    }

    return {
      verdict,
      reasoning: typeof o["reasoning"] === "string" ? o["reasoning"] : "",
      divergence: typeof o["divergence"] === "string" ? o["divergence"] : "",
    };
  }

  return undefined;
}

export interface ResolveProviderOptions {
  /** `anthropic`, `openai-compatible`, or a shorthand like `gemini`/`ollama`. */
  provider?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
}

export interface ResolvedProvider {
  provider?: Provider;
  config: ProviderConfig;
  /** Set when we could not build a provider; rendered verbatim to the user. */
  unavailable?: string;
}

/**
 * Turn CLI flags into a provider, or an explanation of why not.
 *
 * Never throws: an unusable semantic configuration must degrade to "skipped,
 * here is why" rather than failing the whole lint, because every deterministic
 * finding in the run is still valid.
 */
export function resolveProvider(options: ResolveProviderOptions = {}): ResolvedProvider {
  const raw = (options.provider ?? "anthropic").toLowerCase();

  if (raw === "anthropic") {
    const model = options.model ?? "claude-opus-5";
    const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    const config: ProviderConfig = { kind: "anthropic", model, apiKey };
    if (!apiKey) {
      return {
        config,
        unavailable: "ANTHROPIC_API_KEY is not set — semantic adjudication was skipped.",
      };
    }
    return { provider: new AnthropicProvider(config), config };
  }

  const shorthand = raw in KNOWN_BASE_URLS ? raw : undefined;
  const baseUrl = options.baseUrl ?? (shorthand ? KNOWN_BASE_URLS[shorthand] : undefined);

  if (!baseUrl) {
    return {
      config: { kind: "openai-compatible", model: options.model ?? "", apiKey: undefined },
      unavailable:
        `Unknown semantic provider "${raw}". Use anthropic, ` +
        `${Object.keys(KNOWN_BASE_URLS).join(", ")}, or pass --semantic-base-url.`,
    };
  }

  const envNames = shorthand ? (KNOWN_KEY_ENV[shorthand] ?? []) : [];
  const apiKey =
    options.apiKey ??
    firstEnv([...envNames, "OPENAI_API_KEY", "SEMANTIC_API_KEY"]);

  const model = options.model ?? defaultModelFor(shorthand);
  const config: ProviderConfig = { kind: "openai-compatible", model, apiKey, baseUrl };

  // Local servers need no credential; remote ones do.
  const needsKey = !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl);
  if (needsKey && !apiKey) {
    return {
      config,
      unavailable:
        `No API key found for "${raw}". Set ` +
        `${(envNames.length ? envNames : ["SEMANTIC_API_KEY"]).join(" or ")} and retry.`,
    };
  }

  if (!model) {
    return { config, unavailable: `No model specified for "${raw}" — pass --semantic-model.` };
  }

  return { provider: new OpenAICompatibleProvider(config), config };
}

function firstEnv(names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
}

function defaultModelFor(shorthand: string | undefined): string {
  switch (shorthand) {
    case "gemini":
      // flash-lite rather than flash: the judging task is a short pairwise
      // classification, and the lite tier has materially more generous free
      // quota — `gemini-2.0-flash` returned HTTP 429 on a fresh key.
      //
      // The moving `-latest` alias rather than a pinned version: a pinned
      // `-preview` default starts returning 404 the moment that preview is
      // retired, which would break the feature for every user at once. Pin
      // explicitly with --semantic-model when reproducibility matters more.
      return "gemini-flash-lite-latest";
    case "groq":
      return "llama-3.3-70b-versatile";
    default:
      return "";
  }
}
