/**
 * Fails if `vitest run` reported success without actually running every suite.
 *
 * This is not paranoia. On Windows under load the forks pool can lose a worker
 * (`spawn UNKNOWN`, `kill EPERM`, "Timeout terminating forks worker"), and one
 * observed run printed `Test Files 16 passed (16)` and exited 0 while
 * `permissions.test.ts` never executed. Seventeen files exist. A green exit code
 * that quietly covers less than it did yesterday is the exact failure this
 * project already shipped once — eleven tests skipped themselves in CI for weeks
 * because the build step ran after them.
 *
 * So the count is asserted against the filesystem rather than trusted from the
 * summary line.
 *
 * Usage: node scripts/assert-test-collection.mjs <vitest-json-report>
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: node scripts/assert-test-collection.mjs <vitest-json-report>");
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, "..");
const testDir = join(repoRoot, "test");

const onDisk = readdirSync(testDir, { recursive: true })
  .map((entry) => String(entry).replace(/\\/g, "/"))
  .filter((entry) => entry.endsWith(".test.ts"))
  .sort();

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  console.error(`Could not read the vitest report at ${reportPath}: ${error.message}`);
  console.error("Did the run crash before writing it? That is itself a failure.");
  process.exit(1);
}

const ran = (report.testResults ?? [])
  .map((r) => relative(testDir, r.name).replace(/\\/g, "/"))
  .sort();

const missing = onDisk.filter((f) => !ran.includes(f));
const unexpected = ran.filter((f) => !onDisk.includes(f));

// A suite whose every test is skipped still counts as collected — the skips are
// deliberate (conformance fixtures that need a recorded oracle). What must never
// happen is a file vanishing from the report entirely.
if (missing.length > 0 || unexpected.length > 0) {
  console.error(`Test collection mismatch: ${ran.length} suite(s) ran, ${onDisk.length} on disk.`);
  for (const f of missing) console.error(`  NEVER RAN  test/${f}`);
  for (const f of unexpected) console.error(`  UNKNOWN    test/${f}`);
  console.error("");
  console.error("If a worker died, the summary line above may still say every file passed.");
  process.exit(1);
}

const counts = {
  suites: ran.length,
  tests: report.numTotalTests ?? 0,
  passed: report.numPassedTests ?? 0,
  skipped: report.numPendingTests ?? 0,
  failed: report.numFailedTests ?? 0,
};

if (counts.failed > 0) {
  console.error(`${counts.failed} test(s) failed.`);
  process.exit(1);
}

console.log(
  `Collection verified: ${counts.suites} suites, ${counts.tests} tests ` +
    `(${counts.passed} passed, ${counts.skipped} skipped).`,
);
