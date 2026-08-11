import { describe, expect, it } from "vitest";

import { renderExplain, renderExplainList, suggestKeys } from "../src/report/text.js";
import type { ResolvedKey } from "../src/model/types.js";

/**
 * `cclint explain` misses.
 *
 * The miss path used to print one line and stop, which was not merely
 * unhelpful — it gave a wrong answer in the case that matters most. A
 * settings.json holding `permissions.deny` plus one trailing comma is discarded
 * wholesale by Claude Code, so the key genuinely does not resolve. Reporting
 * only "no settings key matches" reads as "you have no deny configured", when
 * the truth is "your deny is in the file and is not in effect" — and `explain`
 * returns before diagnostics print, so nothing else on that run says otherwise.
 */

const key = (path: string, line = 1, file = "/p/.claude/settings.json"): ResolvedKey => ({
  path,
  strategy: "override",
  effective: "x",
  contributions: [{ layer: "projectShared", file, value: "x", position: { line, column: 1 } }],
  shadowed: [],
});

const ALL = [key("permissions.allow"), key("permissions.deny", 3), key("model"), key("theme")];
const NO_DISCARDS = { all: ALL, discarded: [] };

describe("explain misses", () => {
  it("names the discarded file that explains the miss", () => {
    const out = renderExplain([], "/p", "permissions.deny", {
      all: [],
      discarded: [
        { file: "/p/.claude/settings.json", reason: "Trailing comma is not allowed here" },
      ],
    });
    expect(out).toContain("discarded");
    expect(out).toContain("settings.json");
    expect(out).toContain("Trailing comma");
    // The actionable half: why its keys are absent here AND in Claude Code.
    expect(out).toMatch(/Claude Code ignores them too/);
  });

  it("reports discards on a HIT too, not just a miss", () => {
    // The silent case. A discarded project file makes a user-level value
    // "effective" — a correct answer that looks like the tool ignored the
    // project layer, with nothing to say the file was thrown away.
    const out = renderExplain([key("model")], "/p", "model", {
      all: ALL,
      discarded: [{ file: "/p/.claude/settings.local.json", reason: "invalid JSON" }],
    });
    expect(out).toContain("settings.local.json");
    expect(out).toContain("discarded");
  });

  it("suggests the key a typo meant", () => {
    // Without this, `explain permisions.deny` and a genuinely absent deny list
    // are indistinguishable — the difference between "verified absent" and "I
    // misspelled it" on a security key.
    const out = renderExplain([], "/p", "permisions.deny", NO_DISCARDS);
    expect(out).toContain("Did you mean?");
    expect(out).toContain("permissions.deny");
  });

  it("suggests on a substring, since matching is by prefix", () => {
    // "deny" is the word people think in, but it is not a prefix of any key.
    expect(suggestKeys("deny", ALL).map((k) => k.path)).toContain("permissions.deny");
  });

  it("says how many keys exist, so a wrong project root is legible", () => {
    // Discovery landing on the wrong root makes every query miss. "0 key(s)
    // are available" is what turns "this tool is broken" into "my root is
    // wrong".
    const out = renderExplain([], "/p", "model", { all: [], discarded: [] });
    expect(out).toContain("0 key(s) are available");
    expect(out).toContain("doctor");
  });

  it("does not invent suggestions for a genuinely unrelated key", () => {
    // Suggesting something for every miss would train users to ignore the
    // section, which costs more than it gives.
    const out = renderExplain([], "/p", "zzzzzzzzzzunrelated", NO_DISCARDS);
    expect(out).not.toContain("Did you mean?");
  });
});

describe("explain with no key", () => {
  it("lists the available keys rather than erroring", () => {
    const out = renderExplainList("/p", NO_DISCARDS);
    for (const k of ALL) expect(out).toContain(k.path);
    expect(out).toContain("prefix");
  });

  it("says so plainly when nothing resolved", () => {
    const out = renderExplainList("/p", { all: [], discarded: [] });
    expect(out).toContain("No settings keys were resolved");
    expect(out).toContain("doctor");
  });

  it("still reports discards when listing", () => {
    const out = renderExplainList("/p", {
      all: ALL,
      discarded: [{ file: "/p/.claude/settings.json", reason: "invalid JSON" }],
    });
    expect(out).toContain("discarded");
  });
});
