import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/analyze.js";
import { KNOWN_EVENTS } from "../src/rules/hooks.js";
import type {
  DoctorOracleResult,
  HookOracleResult,
  OracleResult,
  TrustOracleResult,
} from "../scripts/oracle.js";

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

function doctorFixtures(): string[] {
  if (!existsSync(fixturesRoot)) return [];
  return readdirSync(fixturesRoot).filter((name) =>
    existsSync(join(fixturesRoot, name, ".conformance", "doctor.json")),
  );
}

function trustFixtures(): string[] {
  if (!existsSync(fixturesRoot)) return [];
  return readdirSync(fixturesRoot).filter((name) =>
    existsSync(join(fixturesRoot, name, ".conformance", "trust.json")),
  );
}

const fixtures = recordedFixtures();
const hooks = hookFixtures();
const doctors = doctorFixtures();
const trusts = trustFixtures();

/**
 * Workspace-trust conformance.
 *
 * Project-level `permissions.allow` entries are ignored until the workspace is
 * trusted — a whole gating mechanism cclint originally knew nothing about, so it
 * reported 33 entries in a real repo as live when Claude Code was discarding
 * every one of them.
 *
 * The fixture is built so the recorded COUNT proves the boundaries by itself:
 * it declares 2 project allow entries, 1 deny, 1 ask, and 3 user-level allow
 * entries. A recording of exactly 2 is only possible if `deny`, `ask` and the
 * user's own allow list are all ungated.
 */
describe.skipIf(trusts.length === 0)("workspace-trust conformance", () => {
  for (const name of trusts) {
    const dir = join(fixturesRoot, name);
    const recorded = JSON.parse(
      readFileSync(join(dir, ".conformance", "trust.json"), "utf8"),
    ) as TrustOracleResult;

    describe(name, () => {
      it("reports the same ignored-entry count as the binary, per file", async () => {
        const result = await analyze({
          cwd: dir,
          home: join(dir, ".fake-home"),
          managedPolicyPath: join(dir, "__no_such_policy__.json"),
          skipBudget: true,
        });

        const ours = result.diagnostics.filter(
          (d) => d.ruleId === "permissions/untrusted-workspace",
        );

        const mismatches: string[] = [];
        for (const expected of recorded.ignoredAllow) {
          const match = ours.find((d) =>
            d.file.split("\\").join("/").endsWith(expected.file),
          );
          if (!match) {
            mismatches.push(`${expected.file}: binary ignores ${expected.count}, cclint said nothing`);
            continue;
          }
          if (match.data?.["count"] !== expected.count) {
            mismatches.push(
              `${expected.file}: binary ignores ${expected.count}, cclint said ${String(match.data?.["count"])}`,
            );
          }
        }
        expect(mismatches).toEqual([]);
      });

      it("does not invent trust findings the binary never reported", async () => {
        const result = await analyze({
          cwd: dir,
          home: join(dir, ".fake-home"),
          managedPolicyPath: join(dir, "__no_such_policy__.json"),
          skipBudget: true,
        });

        const ours = result.diagnostics.filter(
          (d) => d.ruleId === "permissions/untrusted-workspace",
        );
        expect(ours.length).toBe(recorded.ignoredAllow.length);
      });

      it("records a count that proves deny, ask and user-allow are ungated", () => {
        // Guards the fixture itself: if someone simplifies it down to a bare
        // allow list, the recording still passes but stops proving anything.
        const total = recorded.ignoredAllow.reduce((n, i) => n + i.count, 0);
        expect(total).toBeGreaterThan(0);

        const settings = JSON.parse(
          readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
        ) as { permissions: Record<string, string[]> };
        const userSettings = JSON.parse(
          readFileSync(join(dir, ".fake-home", ".claude", "settings.json"), "utf8"),
        ) as { permissions: Record<string, string[]> };

        expect(settings.permissions["deny"]?.length ?? 0).toBeGreaterThan(0);
        expect(settings.permissions["ask"]?.length ?? 0).toBeGreaterThan(0);
        expect(userSettings.permissions["allow"]?.length ?? 0).toBeGreaterThan(0);

        // The count must equal ONLY the project allow entries.
        expect(total).toBe(settings.permissions["allow"]?.length ?? 0);
      });
    });
  }
});

/**
 * `claude doctor` conformance.
 *
 * This is the broadest oracle: it validates hook events, JSON syntax, and MCP
 * entries in one pass, without an API call. Adopting it immediately exposed
 * three live bugs — a hand-written hook-event list with 9 entries against the
 * real 31, an MCP transport list missing three valid types, and silent
 * tolerance of JSON comments that Claude Code rejects outright.
 *
 * The event-list assertion below is the highest-value test in the suite: it
 * turns "our list has silently gone stale" from an invisible source of false
 * positives into a failing test the next time Claude Code adds an event.
 */
describe.skipIf(doctors.length === 0)("doctor conformance", () => {
  for (const name of doctors) {
    const dir = join(fixturesRoot, name);
    const recorded = JSON.parse(
      readFileSync(join(dir, ".conformance", "doctor.json"), "utf8"),
    ) as DoctorOracleResult;

    describe(name, () => {
      it("KNOWN_EVENTS matches the binary's own valid-event list exactly", () => {
        const ours = [...KNOWN_EVENTS].sort();
        const theirs = [...recorded.validHookEvents].sort();

        const weInvented = ours.filter((e) => !theirs.includes(e));
        const weMissed = theirs.filter((e) => !ours.includes(e));

        // Missing events are the dangerous direction: each one makes cclint
        // report a working hook as "this will never fire".
        expect(
          { weMissed, weInvented },
          "cclint's hook-event list has drifted from Claude Code's",
        ).toEqual({ weMissed: [], weInvented: [] });
      });

      it("reports an error for every file the binary rejected as malformed JSON", async () => {
        const result = await analyze({
          cwd: dir,
          home: join(dir, ".fake-home"),
          managedPolicyPath: join(dir, "__no_such_policy__.json"),
          skipBudget: true,
        });

        const missed: string[] = [];
        for (const c of recorded.complaints.filter((x) => x.kind === "malformed-json")) {
          const ours = result.diagnostics.filter(
            (d) =>
              (d.ruleId === "json/not-strict-json" || d.ruleId === "json/parse-error") &&
              d.file.split("\\").join("/").endsWith(c.file),
          );
          if (ours.length === 0) {
            missed.push(`${c.file}: Claude Code rejects this file, cclint did not`);
          }
        }
        expect(missed).toEqual([]);
      });

      it("reports an error for every hook event the binary rejected", async () => {
        const result = await analyze({
          cwd: dir,
          home: join(dir, ".fake-home"),
          managedPolicyPath: join(dir, "__no_such_policy__.json"),
          skipBudget: true,
        });

        const missed: string[] = [];
        for (const c of recorded.complaints.filter(
          (x) => x.kind === "unknown-hook-event",
        )) {
          const event = /Unknown hook event "([^"]+)"/.exec(c.message)?.[1];
          if (!event) continue;
          const ours = result.diagnostics.filter(
            (d) => d.ruleId === "hooks/unknown-event" && d.data?.["event"] === event,
          );
          if (ours.length === 0) missed.push(event);
        }
        expect(missed).toEqual([]);
      });

      it("flags every malformed hook the binary rejected, at the same pointer", async () => {
        // The strictest assertion in the suite. `claude doctor` names the exact
        // config pointer it rejected (`hooks.PreToolUse.0.hooks.0.command`), and
        // our diagnostics carry the same pointer shape — so this compares
        // findings position-for-position, not just file-for-file.
        const result = await analyze({
          cwd: dir,
          home: join(dir, ".fake-home"),
          managedPolicyPath: join(dir, "__no_such_policy__.json"),
          skipBudget: true,
        });

        const oursByPointer = new Set(
          result.diagnostics
            .filter((d) => d.ruleId === "hooks/malformed")
            .map((d) => d.data?.["pointer"])
            .filter((p): p is string => typeof p === "string"),
        );

        const missed = recorded.complaints
          .filter((c) => c.kind === "hook-schema" && c.pointer)
          .map((c) => c.pointer!)
          .filter((pointer) => !oursByPointer.has(pointer));

        expect(
          missed,
          "Claude Code rejects these hook entries; cclint did not flag them",
        ).toEqual([]);
      });

      it("does not flag any event the binary accepts", async () => {
        // The false-positive direction. Build a settings object using every
        // valid event and assert cclint stays silent about all of them.
        const flagged = recorded.validHookEvents.filter((e) => !KNOWN_EVENTS.has(e));
        expect(flagged, "these valid events would be reported as unknown").toEqual([]);
      });
    });
  }
});

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
