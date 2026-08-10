import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  coerceAdjudication,
  resolveProvider,
  schemaInstruction,
  KNOWN_BASE_URLS,
} from "../src/semantic/providers.js";

/**
 * Semantic providers.
 *
 * The default path is Anthropic and is unchanged. The OpenAI-compatible path
 * exists so the pass can run against Gemini, Ollama, OpenRouter or a local
 * server — one adapter rather than one code path per vendor.
 */

const SAVED = { ...process.env };

beforeEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "SEMANTIC_API_KEY"]) {
    delete process.env[k];
  }
});
afterEach(() => {
  process.env = { ...SAVED };
});

describe("provider resolution", () => {
  it("defaults to anthropic and reports a missing key rather than throwing", () => {
    const r = resolveProvider();
    expect(r.config.kind).toBe("anthropic");
    expect(r.provider).toBeUndefined();
    expect(r.unavailable).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("builds the anthropic provider when a key is present", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    const r = resolveProvider();
    expect(r.provider?.label).toBe("anthropic:claude-opus-5");
    expect(r.unavailable).toBeUndefined();
  });

  it("resolves the gemini shorthand to its OpenAI-compatible endpoint", () => {
    process.env["GEMINI_API_KEY"] = "k";
    const r = resolveProvider({ provider: "gemini" });
    expect(r.config.baseUrl).toBe(KNOWN_BASE_URLS["gemini"]);
    expect(r.provider).toBeDefined();
  });

  it("accepts GOOGLE_API_KEY as well as GEMINI_API_KEY", () => {
    process.env["GOOGLE_API_KEY"] = "k";
    expect(resolveProvider({ provider: "gemini" }).provider).toBeDefined();
  });

  it("names the env vars to set when a remote provider has no key", () => {
    const r = resolveProvider({ provider: "gemini" });
    expect(r.provider).toBeUndefined();
    expect(r.unavailable).toMatch(/GEMINI_API_KEY or GOOGLE_API_KEY/);
  });

  it("needs no key for a local server", () => {
    // Ollama is unauthenticated on localhost; demanding a key would make the
    // zero-cost local path impossible to use.
    const r = resolveProvider({ provider: "ollama", model: "qwen2.5vl:3b" });
    expect(r.provider).toBeDefined();
    expect(r.unavailable).toBeUndefined();
  });

  it("rejects an unknown provider with the list of valid ones", () => {
    const r = resolveProvider({ provider: "not-a-provider" });
    expect(r.provider).toBeUndefined();
    expect(r.unavailable).toMatch(/anthropic/);
    expect(r.unavailable).toMatch(/gemini/);
  });

  it("accepts an arbitrary base url without a shorthand", () => {
    const r = resolveProvider({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "local",
    });
    expect(r.provider).toBeDefined();
  });

  it("labels the provider so cached verdicts cannot cross models", () => {
    // The cache key embeds this label. Without it, a verdict from a 3B local
    // model would be replayed as though a frontier model had produced it.
    process.env["GEMINI_API_KEY"] = "k";
    const gemini = resolveProvider({ provider: "gemini" }).provider?.label;
    const ollama = resolveProvider({ provider: "ollama", model: "qwen" }).provider?.label;
    expect(gemini).not.toBe(ollama);
  });
});

describe("verdict parsing", () => {
  const ok = '{"verdict":"conflict","reasoning":"r","divergence":"d"}';

  it("parses a bare JSON object", () => {
    expect(coerceAdjudication(ok)?.verdict).toBe("conflict");
  });

  it("parses JSON wrapped in a markdown fence", () => {
    expect(coerceAdjudication("```json\n" + ok + "\n```")?.verdict).toBe("conflict");
  });

  it("parses JSON preceded by prose", () => {
    expect(coerceAdjudication("Sure! Here you go:\n" + ok)?.reasoning).toBe("r");
  });

  it("is case-insensitive about the verdict value", () => {
    expect(coerceAdjudication('{"verdict":"COMPATIBLE"}')?.verdict).toBe("compatible");
  });

  it("returns undefined for an unrecognised verdict rather than guessing", () => {
    // A wrong "compatible" is silent under-reporting; abstaining is honest.
    expect(coerceAdjudication('{"verdict":"maybe","reasoning":"x"}')).toBeUndefined();
  });

  it("returns undefined for non-JSON", () => {
    expect(coerceAdjudication("I think they conflict.")).toBeUndefined();
  });

  it("tolerates missing reasoning without dropping the verdict", () => {
    const v = coerceAdjudication('{"verdict":"conflict"}');
    expect(v?.verdict).toBe("conflict");
    expect(v?.reasoning).toBe("");
  });
});

describe("schema instruction", () => {
  it("names every required field", () => {
    // Regression guard. `response_format: json_object` only asks for "some
    // JSON" — without the field names in the prompt, Gemini returned a valid
    // verdict with reasoning and divergence missing, and findings rendered as
    // "Conflicting instructions:" followed by nothing.
    const text = schemaInstruction({ type: "object" });
    for (const field of ["verdict", "reasoning", "divergence"]) {
      expect(text).toContain(field);
    }
    expect(text).toContain("conflict");
    expect(text).toContain("insufficient_evidence");
  });
});
