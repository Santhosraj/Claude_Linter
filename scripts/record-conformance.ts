/**
 * Regenerate conformance expectations from the installed Claude Code binary.
 *
 *   npm run conformance:record
 *
 * Run this when Claude Code updates. The recorded files are committed, and CI
 * replays them without needing the binary — so a behaviour change shows up as a
 * failing test with a readable diff instead of as a silently wrong linter.
 *
 * A fixture declares which oracles apply in its `.oracle.json`:
 *   {"oracles":["mcp"]}
 *   {"oracles":["hooks"],"event":"UserPromptSubmit"}
 *
 * Neither oracle makes an API call, so recording is free.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { recordDoctorOracle, recordHookOracle, recordOracle, recordTrustOracle } from "./oracle.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(here, "..", "test", "fixtures");

interface OracleSpec {
  oracles: string[];
  event?: string;
}

/**
 * Files a fixture's fake home is allowed to contain. Everything else under
 * `.claude/` is state the binary wrote and must not be committed.
 */
const FAKE_HOME_KEEP = new Set(["settings.json", "settings.local.json", "CLAUDE.md"]);

/**
 * Scrub everything the real binary wrote into the fixture's sandboxed home.
 *
 * This is an ALLOWLIST on purpose. The previous version deleted a hardcoded set
 * (`.claude.json`, `backups/`, `statsig/`) and promptly missed `projects/`,
 * which accumulates a session transcript per probe — one more untracked file
 * every time anyone records. A blocklist will always lag the binary; an
 * allowlist cannot.
 */
function cleanFakeHome(fakeHome: string): void {
  rmSync(join(fakeHome, ".claude.json"), { force: true });

  const claudeDir = join(fakeHome, ".claude");
  if (!existsSync(claudeDir)) return;

  for (const entry of readdirSync(claudeDir)) {
    if (FAKE_HOME_KEEP.has(entry)) continue;
    rmSync(join(claudeDir, entry), { recursive: true, force: true });
  }
}

function readSpec(dir: string): OracleSpec | undefined {
  const file = join(dir, ".oracle.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as OracleSpec;
    return Array.isArray(parsed.oracles) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function write(dir: string, name: string, payload: unknown): void {
  const outDir = join(dir, ".conformance");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, name), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function main(): number {
  const fixtures = readdirSync(fixturesRoot).filter((name) => {
    const dir = join(fixturesRoot, name);
    return readSpec(dir) !== undefined && existsSync(join(dir, ".fake-home"));
  });

  if (fixtures.length === 0) {
    process.stderr.write(
      "No recordable fixtures found. A fixture needs a .oracle.json and a .fake-home/ directory.\n",
    );
    return 1;
  }

  let failures = 0;

  for (const name of fixtures) {
    const dir = join(fixturesRoot, name);
    const fakeHome = join(dir, ".fake-home");
    const spec = readSpec(dir)!;

    for (const oracle of spec.oracles) {
      process.stdout.write(`recording ${name} [${oracle}] ... `);
      try {
        if (oracle === "mcp") {
          const result = recordOracle(dir, fakeHome);
          write(dir, "mcp.json", result);
          const skipped = Object.values(result.servers).filter(
            (s) => s.status === "skipped",
          ).length;
          process.stdout.write(
            `ok (claude ${result.claudeVersion}, ${Object.keys(result.servers).length} servers, ${skipped} skipped)\n`,
          );
        } else if (oracle === "doctor") {
          const result = recordDoctorOracle(dir, fakeHome);
          write(dir, "doctor.json", result);
          process.stdout.write(
            `ok (claude ${result.claudeVersion}, ${result.validHookEvents.length} valid hook events, ` +
              `${result.complaints.length} complaint(s))\n`,
          );
        } else if (oracle === "trust") {
          const result = recordTrustOracle(dir, fakeHome);
          write(dir, "trust.json", result);
          process.stdout.write(
            `ok (claude ${result.claudeVersion}, ignored: ` +
              result.ignoredAllow.map((i) => `${i.count} in ${i.file}`).join("; ") +
              ")\n",
          );
        } else if (oracle === "hooks") {
          const result = recordHookOracle(dir, fakeHome, spec.event ?? "UserPromptSubmit");
          write(dir, "hooks.json", result);
          process.stdout.write(
            `ok (claude ${result.claudeVersion}, executed: ${result.executed.join(" → ")})\n`,
          );
        } else {
          throw new Error(`unknown oracle "${oracle}"`);
        }
      } catch (error) {
        failures++;
        process.stdout.write("FAILED\n");
        process.stderr.write(
          `  ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        cleanFakeHome(fakeHome);
      }
    }
  }

  return failures > 0 ? 1 : 0;
}

process.exitCode = main();
