import { describe, expect, it } from "vitest";

import { contextWindowFor, resolveContextWindow } from "../src/tokens/budget.js";

/**
 * The context-window denominator.
 *
 * The percentage the budget reports is only as good as this number, and a wrong
 * denominator is invisible in a percentage — nothing about "1.63%" reveals that
 * the window underneath it was a guess. Two failure directions, both real:
 *
 *   - An unrecognised model fell to 200K, overstating the share up to fivefold.
 *     `claude-mythos-5` (1M) did exactly that: the previous single regex listed
 *     `fable-5`, `opus-5` and `sonnet-5` but not `mythos-5`.
 *   - A project that sets no `model` is analysed as the 1M default, so someone
 *     genuinely running Haiku sees a share five times too small.
 *
 * Windows are per the Claude model catalogue: 1M for Fable 5, Mythos 5, Opus 5,
 * Opus 4.8/4.7/4.6, Sonnet 5 and Sonnet 4.6 — the default now, not a beta —
 * and 200K for Haiku 4.5.
 */
describe("context window resolution", () => {
  it.each([
    ["claude-fable-5", 1_000_000],
    ["claude-mythos-5", 1_000_000],
    ["claude-opus-5", 1_000_000],
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-4-6", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-haiku-4-5", 200_000],
  ])("knows %s is %i tokens", (model, tokens) => {
    const resolved = resolveContextWindow(model);
    expect(resolved.tokens).toBe(tokens);
    expect(resolved.known).toBe(true);
  });

  it("resolves a `[1m]` deployment suffix, which appears in real settings", () => {
    // `model: "opus[1m]"` is what a live user settings file contained.
    const resolved = resolveContextWindow("opus[1m]");
    expect(resolved.tokens).toBe(1_000_000);
    expect(resolved.known).toBe(true);
  });

  it("does not treat a bare `1m` substring as a 1M window", () => {
    // The old check accepted any string containing "1m", which would match an
    // unrelated future ID. Only the bracketed deployment suffix counts.
    expect(resolveContextWindow("claude-future-1minute").known).toBe(false);
  });

  it("checks haiku before the 1M families, so a haiku variant cannot slip through", () => {
    expect(resolveContextWindow("claude-haiku-9-sonnet-5-flavoured").tokens).toBe(200_000);
  });

  it("reports an unknown model as assumed rather than inventing certainty", () => {
    const resolved = resolveContextWindow("claude-something-not-released-yet");
    expect(resolved.known).toBe(false);
    // The smaller of the two live windows: an unknown model's share is
    // over-reported rather than under-reported.
    expect(resolved.tokens).toBe(200_000);
  });

  it("keeps contextWindowFor returning a bare number for existing callers", () => {
    expect(contextWindowFor("claude-opus-5")).toBe(1_000_000);
    expect(contextWindowFor("claude-haiku-4-5")).toBe(200_000);
  });
});
