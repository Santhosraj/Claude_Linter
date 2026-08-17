import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/analyze.js";
import { KNOWN_EVENTS } from "../src/rules/hooks.js";
import type {
  DoctorOracleResult,
  HookOracleResult,
  OracleResult,
  RuntimeOracleResult,
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

function runtimeFixtures(): string[] {
  if (!existsSync(fixturesRoot)) return [];
  return readdirSync(fixturesRoot).filter((name) =>
    existsSync(join(fixturesRoot, name, ".conformance", "runtime.json")),
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
const runtimes = runtimeFixtures();

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
      /**
       * The binary coalesces: one message can name several files and carry a
       * single combined count, so per-file counts are NOT recoverable from its
       * output. cclint deliberately reports one finding per file (33 copies of
       * one sentence is not a report), so the two shapes are compared on the
       * only terms both can express: which files were named, and the total.
       */
      it("names the same files the binary named, and the same total", async () => {
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
          const matched = expected.files.map((file) => ({
            file,
            diagnostic: ours.find((d) => d.file.split("\\").join("/").endsWith(file)),
          }));

          for (const { file, diagnostic } of matched) {
            if (!diagnostic) {
              mismatches.push(`${file}: binary drops entries here, cclint said nothing`);
            }
          }

          const total = matched.reduce((n, m) => {
            const count = m.diagnostic?.data?.["count"];
            return n + (typeof count === "number" ? count : 0);
          }, 0);

          if (total !== expected.count) {
            mismatches.push(
              `[${expected.files.join(", ")}]: binary ignores ${expected.count} ` +
                `in total, cclint accounts for ${total}`,
            );
          }
        }
        expect(mismatches).toEqual([]);
      });

      /**
       * The false-positive direction, and the assertion that caught the bug
       * this fixture exists for.
       *
       * cclint used to gate `permissions.allow` from BOTH project layers. The
       * binary gates only `settings.json`: with allow entries in both project
       * files it names that file alone, and its count excludes the local
       * layer's entries. cclint therefore reported a `settings.local.json`
       * grant as dead while Claude Code was honouring it.
       *
       * Comparing counts alone would not have caught it — the recorded total
       * matched cclint's finding for `settings.json` perfectly. It took
       * comparing the SET of files each side named.
       */
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
        const named = new Set(recorded.ignoredAllow.flatMap((i) => i.files));

        // One finding per file the binary named, and none for any file it did not.
        const oursFiles = ours.map((d) => d.file.split("\\").join("/"));
        const invented = oursFiles.filter(
          (f) => ![...named].some((n) => f.endsWith(n)),
        );

        expect(
          invented,
          "cclint claims these files have ignored allow entries; the binary does not",
        ).toEqual([]);
        expect(ours.length).toBe(named.size);
      });

      /**
       * The remediation has to name the key the binary actually reads.
       *
       * cclint keyed trust on its own `projectRoot`, and `.claude` is a strong
       * root marker here — so a directory carrying one becomes our root while the
       * binary keeps walking to the enclosing git root. The advice then named a
       * key Claude Code never reads: following it exactly leaves the warning in
       * place, which is worse than saying nothing.
       *
       * Recorded relative to the fixture so the expectation is not the
       * recorder's own absolute path.
       */
      it.skipIf(recorded.trustKeyRelative === undefined)(
        "keys trust on the same directory the binary asks for",
        async () => {
          const result = await analyze({
            cwd: dir,
            home: join(dir, ".fake-home"),
            managedPolicyPath: join(dir, "__no_such_policy__.json"),
            skipBudget: true,
          });

          const ours = result.context.discovery.workspaceTrust.key;
          expect(ours, "cclint recorded no trust key").toBeDefined();

          const oursRelative = relative(dir, ours!).split("\\").join("/") || ".";
          expect(
            oursRelative,
            "the directory cclint keys trust on vs the one the binary named",
          ).toBe(recorded.trustKeyRelative);
        },
      );

      it("records a count that proves deny, ask and user-allow are ungated", () => {
        // Guards the fixture itself: if someone simplifies it down to a bare
        // allow list, the recording still passes but stops proving anything.
        const total = recorded.ignoredAllow.reduce((n, i) => n + i.count, 0);
        expect(total).toBeGreaterThan(0);

        const read = (...parts: string[]) => {
          const file = join(dir, ...parts);
          if (!existsSync(file)) return undefined;
          return JSON.parse(readFileSync(file, "utf8")) as {
            permissions?: Record<string, string[]>;
          };
        };

        const shared = read(".claude", "settings.json");
        const local = read(".claude", "settings.local.json");
        const user = read(".fake-home", ".claude", "settings.json");

        const projectFiles = [shared, local].filter((s) => s !== undefined);
        const sum = (list: string) =>
          projectFiles.reduce((n, s) => n + (s.permissions?.[list]?.length ?? 0), 0);

        expect(sum("deny")).toBeGreaterThan(0);
        expect(sum("ask")).toBeGreaterThan(0);
        expect(user?.permissions?.["allow"]?.length ?? 0).toBeGreaterThan(0);

        /**
         * The count must equal the allow entries in exactly the files the binary
         * NAMED — not every project file present.
         *
         * Summing all project layers is the tempting version and it is wrong:
         * the binary excludes a local layer it did not name, so summing both
         * would assert a total the binary never reported and fail on a correct
         * recording. Reading the file list off the recording keeps this test
         * measuring the boundary instead of guessing at it.
         */
        const namedFiles = new Set(recorded.ignoredAllow.flatMap((i) => i.files));
        const allowInNamed =
          (namedFiles.has(".claude/settings.json")
            ? (shared?.permissions?.["allow"]?.length ?? 0)
            : 0) +
          (namedFiles.has(".claude/settings.local.json")
            ? (local?.permissions?.["allow"]?.length ?? 0)
            : 0);

        expect(total).toBe(allowInNamed);
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

/**
 * Runtime-state conformance — what the binary actually resolved.
 *
 * The hook oracle proved only that hooks fire. But a hook is a shell command
 * running inside the fully resolved runtime, before authentication and with no
 * API call, so it can report what that runtime decided: the environment it
 * injected, and the `permission_mode` in its stdin payload.
 *
 * That is what promoted `env` and `permissions.defaultMode` off `documented`.
 * Neither needed a new mechanism — only noticing the existing one could see more
 * than it was being asked. Both were previously believed from documentation,
 * which is exactly the tier that produced a live false positive in the trust rule.
 */
describe.skipIf(runtimes.length === 0)("runtime-state conformance", () => {
  for (const name of runtimes) {
    const dir = join(fixturesRoot, name);
    const recorded = JSON.parse(
      readFileSync(join(dir, ".conformance", "runtime.json"), "utf8"),
    ) as RuntimeOracleResult;

    describe(name, () => {
      const analyzeFixture = () =>
        analyze({
          cwd: dir,
          home: join(dir, ".fake-home"),
          configDir: join(dir, ".fake-home", ".claude"),
          managedPolicyPath: join(dir, "__no_such_policy__.json"),
          skipBudget: true,
        });

      it.skipIf(Object.keys(recorded.env).length === 0)(
        "resolves every env var to the value the runtime injected",
        async () => {
          const result = await analyzeFixture();

          const mismatches: string[] = [];
          for (const [name, value] of Object.entries(recorded.env)) {
            const key = result.context.keys.find((k) => k.path === `env.${name}`);
            if (!key) {
              mismatches.push(`env.${name}: runtime had "${value}", cclint resolved no such key`);
              continue;
            }
            if (key.effective !== value) {
              mismatches.push(
                `env.${name}: runtime had "${value}", cclint says "${String(key.effective)}"`,
              );
            }
          }
          expect(mismatches).toEqual([]);
        },
      );

      it.skipIf(Object.keys(recorded.env).length === 0)(
        "records a shape that proves per-key merging rather than replacement",
        () => {
          // Guards the fixture. If a later edit leaves only keys that both layers
          // set, the recording still passes while proving nothing: wholesale
          // replacement and per-key merge are indistinguishable without a key that
          // ONLY the lower-precedence layer sets.
          const user = JSON.parse(
            readFileSync(join(dir, ".fake-home", ".claude", "settings.json"), "utf8"),
          ) as { env?: Record<string, string> };
          const project = JSON.parse(
            readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
          ) as { env?: Record<string, string> };

          const userOnly = Object.keys(user.env ?? {}).filter((k) => !(k in (project.env ?? {})));
          expect(userOnly.length).toBeGreaterThan(0);

          // ...and that key must have survived in the recording.
          for (const k of userOnly) expect(recorded.env[k]).toBe(user.env?.[k]);

          // A collided key must exist too, or precedence is untested.
          const collided = Object.keys(project.env ?? {}).filter((k) => k in (user.env ?? {}));
          expect(collided.length).toBeGreaterThan(0);
          for (const k of collided) expect(recorded.env[k]).toBe(project.env?.[k]);
        },
      );

      it.skipIf(recorded.permissionMode === undefined)(
        "resolves permissions.defaultMode to the mode the runtime reported",
        async () => {
          const result = await analyzeFixture();
          const key = result.context.keys.find((k) => k.path === "permissions.defaultMode");

          expect(key, "resolver produced no permissions.defaultMode key").toBeDefined();
          expect(key!.effective).toBe(recorded.permissionMode);
        },
      );

      it.skipIf(recorded.permissionMode === undefined)(
        "records a mode that differs between layers, so precedence is proven",
        () => {
          // Both layers setting the same mode would pass whatever the rule was.
          const user = JSON.parse(
            readFileSync(join(dir, ".fake-home", ".claude", "settings.json"), "utf8"),
          ) as { permissions?: { defaultMode?: string } };
          const project = JSON.parse(
            readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
          ) as { permissions?: { defaultMode?: string } };

          expect(user.permissions?.defaultMode).toBeDefined();
          expect(project.permissions?.defaultMode).toBeDefined();
          expect(user.permissions?.defaultMode).not.toBe(project.permissions?.defaultMode);
          // The higher-precedence layer is the one that won.
          expect(recorded.permissionMode).toBe(project.permissions?.defaultMode);
        },
      );
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
