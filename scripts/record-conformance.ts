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

import { recordHookOracle, recordOracle } from "./oracle.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(here, "..", "test", "fixtures");

interface OracleSpec {
  oracles: string[];
  event?: string;
}

/**
 * Running an oracle makes the real binary write its own state into the
 * fixture's sandboxed home — including a machineID and userID. Those are
 * gitignored, but we also delete them after each recording so a fixture
 * directory never sits around holding machine-identifying values.
 */
function cleanFakeHome(fakeHome: string): void {
  for (const relPath of [".claude.json", ".claude/backups", ".claude/statsig"]) {
    rmSync(join(fakeHome, relPath), { recursive: true, force: true });
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
