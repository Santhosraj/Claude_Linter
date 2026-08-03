import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/analyze.js";
import type { HookOracleResult, OracleResult } from "../scripts/oracle.js";

/**
 * Differential conformance tests.
 *
 * These replay verdicts recorded from the real Claude Code binary
 * (`npm run conformance:record`) and assert our linter agrees. They run without
 * the binary and without network access, so CI can execute them on every commit
 * and re-record only when Claude Code updates.
 *
 * The assertions are deliberately BIDIRECTIONAL:
 *   - every server the oracle skipped must produce an error from us
 *     (catches false negatives — config Claude Code rejects that we bless)
 *   - every server the oracle accepted must produce no error from us
 *     (catches false positives — the failure mode that gets linters uninstalled)
 */

const fixturesRoot = resolve(__dirname, "fixtures");

function recordedFixtures(): string[] {
  if (!existsSync(fixturesRoot)) return [];
  return readdirSync(fixturesRoot).filter((name) =>
    existsSync(join(fixturesRoot, name, ".conformance", "mcp.json")),
  );
}

function hookFixtures(): string[] {
  if (!existsSync(fixturesRoot)) return [];
  return readdirSync(fixturesRoot).filter((name) =>
    existsSync(join(fixturesRoot, name, ".conformance", "hooks.json")),
  );
}

const fixtures = recordedFixtures();
const hooks = hookFixtures();

/**
 * Hook conformance — the tool's headline claim, proven rather than assumed.
 *
 * `cclint` tells users that hooks from every settings layer are ADDITIVE: a
 * project hook does not replace a user hook, both fire. The entire
 * `settings/shadowed-key` rule is built on that distinction, so if the claim is
 * wrong the tool actively instructs people to delete hooks that are running.
 *
 * The recordings capture which layers' hooks the real binary actually EXECUTED.
 * We assert our resolver predicts exactly that set — no more, no less.
 */
describe.skipIf(hooks.length === 0)("hook conformance", () => {
  for (const name of hooks) {
    const dir = join(fixturesRoot, name);
    const recorded = JSON.parse(
      readFileSync(join(dir, ".conformance", "hooks.json"), "utf8"),
    ) as HookOracleResult;

    describe(name, () => {
      it(`predicts exactly the layers whose ${recorded.event} hooks executed`, async () => {
        const result = await analyze({
          cwd: dir,
          home: join(dir, ".fake-home"),
          managedPolicyPath: join(dir, "__no_such_policy__.json"),
          skipBudget: true,
        });

        const key = result.context.keys.find(
          (k) => k.path === `hooks.${recorded.event}`,
        );
        expect(key, `resolver produced no hooks.${recorded.event} key`).toBeDefined();

        const predicted = [...new Set(key!.contributions.map((c) => c.layer))].sort();
        const actual = [...new Set(recorded.executed)].sort();

        // Bidirectional. A missing layer means we would under-report; an extra
        // layer means we would claim a hook runs when it does not.
        expect(predicted, "layers cclint predicts vs layers that actually ran").toEqual(
          actual,
        );
      });

      it("reports nothing as shadowed, because every layer's hooks ran", async () => {
        const result = await analyze({
          cwd: dir,
          home: join(dir, ".fake-home"),
          managedPolicyPath: join(dir, "__no_such_policy__.json"),
          skipBudget: true,
        });

        const key = result.context.keys.find(
          (k) => k.path === `hooks.${recorded.event}`,
        );
        expect(key?.shadowed).toEqual([]);

        // And no user-visible finding may claim otherwise.
        const bogus = result.diagnostics.filter(
          (d) =>
            d.ruleId === "settings/shadowed-key" &&
            typeof d.data?.["path"] === "string" &&
            (d.data["path"] as string).startsWith("hooks."),
        );
        expect(bogus, "cclint must never call a live hook dead config").toEqual([]);
      });

      it("records more than one layer, so the assertion is not vacuous", () => {
        // A single-layer fixture would pass the checks above trivially and
        // prove nothing about merge behaviour.
        expect(new Set(recorded.executed).size).toBeGreaterThan(1);
      });
    });
  }
});

describe.skipIf(fixtures.length === 0)("mcp conformance", () => {
  for (const name of fixtures) {
    const dir = join(fixturesRoot, name);
    const recorded = JSON.parse(
      readFileSync(join(dir, ".conformance", "mcp.json"), "utf8"),
    ) as OracleResult;

    describe(name, () => {
      it("agrees with the real binary on which servers are usable", async () => {
        const result = await analyze({
          cwd: dir,
          home: join(dir, ".fake-home"),
          // Never read the developer's real enterprise policy during a test.
          managedPolicyPath: join(dir, "__no_such_policy__.json"),
          skipBudget: true,
        });

        const errorsByServer = new Map<string, string[]>();
        for (const d of result.diagnostics) {
          if (d.severity !== "error") continue;
          const server = d.data?.["server"];
          if (typeof server !== "string") continue;
          errorsByServer.set(server, [
            ...(errorsByServer.get(server) ?? []),
            `${d.ruleId}: ${d.message}`,
          ]);
        }

        const disagreements: string[] = [];

        for (const [server, verdict] of Object.entries(recorded.servers)) {
          const ours = errorsByServer.get(server) ?? [];

          if (verdict.status === "skipped" && ours.length === 0) {
            disagreements.push(
              `FALSE NEGATIVE — Claude Code skips "${server}" (${verdict.reason}) ` +
                `but cclint reported no error.`,
            );
          }

          if (verdict.status === "ok" && ours.length > 0) {
            disagreements.push(
              `FALSE POSITIVE — Claude Code accepts "${server}" but cclint ` +
                `reported: ${ours.join("; ")}`,
            );
          }
        }

        expect(disagreements).toEqual([]);
      });

      it("reports exactly one error per rejected server, matching the oracle", async () => {
        const result = await analyze({
          cwd: dir,
          home: join(dir, ".fake-home"),
          managedPolicyPath: join(dir, "__no_such_policy__.json"),
          skipBudget: true,
        });

        const noisy: string[] = [];
        for (const [server, verdict] of Object.entries(recorded.servers)) {
          if (verdict.status !== "skipped") continue;
          const ours = result.diagnostics.filter(
            (d) => d.severity === "error" && d.data?.["server"] === server,
          );
          if (ours.length > 1) {
            noisy.push(
              `"${server}": Claude Code emits 1 diagnostic, cclint emits ` +
                `${ours.length} (${ours.map((d) => d.ruleId).join(", ")})`,
            );
          }
        }
        expect(noisy).toEqual([]);
      });
    });
  }
});

describe.skipIf(fixtures.length === 0)("conformance freshness", () => {
  it("records which Claude Code version the expectations came from", () => {
    for (const name of fixtures) {
      const recorded = JSON.parse(
        readFileSync(join(fixturesRoot, name, ".conformance", "mcp.json"), "utf8"),
      ) as OracleResult;
      expect(recorded.claudeVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(Object.keys(recorded.servers).length).toBeGreaterThan(0);
    }
  });
});
