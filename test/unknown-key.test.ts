import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { analyze } from "../src/analyze.js";
import { KNOWN_SETTINGS_KEYS, suggestSettingsKey } from "../src/model/known-settings.js";

/**
 * `settings/unknown-key` reports likely typos, not every key it has not heard of.
 *
 * It used to treat "absent from the 32-rule merge-semantics table" as
 * "unrecognised", so real keys in a real project — `autoMemoryEnabled`,
 * `modelSettings` — were reported. No key list is complete (SchemaStore lacks
 * `modelSettings`; neither it nor the docs list `switchModelsOnFlag`, which
 * Claude Code writes itself), so absence cannot be the test. Proximity can: a
 * typo is near the key it was meant to be.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function findings(settings: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "cclint-keys-"));
  dirs.push(root);
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(settings));
  const result = await analyze({
    cwd: root,
    home: join(root, "__no_home__"),
    managedPolicyPath: join(root, "__no_policy__.json"),
    skipBudget: true,
    strict: true,
  });
  return result.diagnostics.filter((d) => d.ruleId === "settings/unknown-key");
}

describe("settings/unknown-key", () => {
  it("does not report real keys the merge table does not model", async () => {
    // Both were reported against a real project before.
    expect(await findings({ autoMemoryEnabled: true, modelSettings: {} })).toEqual([]);
  });

  it("does not report a key far from every known one", async () => {
    // Far more often real-but-unlisted than a typo.
    expect(await findings({ totallyMadeUpKey123: true })).toEqual([]);
  });

  it("reports a misspelt key and names the one it was meant to be", async () => {
    const found = await findings({ modle: "claude-opus-5" });
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toMatch(/did you mean `model`\?/);
  });

  it("reports a key that differs only in case — JSON keys are case-sensitive", async () => {
    const found = await findings({ Model: "claude-opus-5" });
    expect(found).toHaveLength(1);
    expect(found[0]?.data?.["suggestion"]).toBe("model");
    expect(found[0]?.detail?.join(" ")).toMatch(/only in case/);
  });

  it("catches a typo of a key only the schema knows about", async () => {
    const found = await findings({ autoMemoryEnabeld: true });
    expect(found[0]?.data?.["suggestion"]).toBe("autoMemoryEnabled");
  });
});

describe("suggestSettingsKey", () => {
  it("counts an adjacent transposition as one edit", () => {
    expect(suggestSettingsKey("modle")).toBe("model");
  });

  it("returns nothing for a known key", () => {
    expect(suggestSettingsKey("model")).toBeUndefined();
  });

  it("allows only one edit for short keys, so they do not match each other loosely", () => {
    // "env" and "agent" are both real; three letters is too short for two edits.
    expect(suggestSettingsKey("xyz")).toBeUndefined();
  });

  it("knows a key from the extra list it is given", () => {
    expect(suggestSettingsKey("autoUpdate", ["autoUpdates"])).toBe("autoUpdates");
  });

  it("covers the schema plus the documented keys the schema misses", () => {
    expect(KNOWN_SETTINGS_KEYS.has("autoMemoryEnabled")).toBe(true);
    expect(KNOWN_SETTINGS_KEYS.has("modelSettings")).toBe(true);
    expect(KNOWN_SETTINGS_KEYS.size).toBeGreaterThan(100);
  });
});
