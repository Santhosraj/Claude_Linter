/**
 * Reports whether the recorded conformance fixtures still describe the current
 * Claude Code release.
 *
 * WHAT THIS DOES AND DOES NOT DO, because the difference matters:
 *
 *   It detects the TRIGGER for re-recording, not behaviour drift itself. Actually
 *   re-deriving the expectations means running `claude -p` and `claude --debug`,
 *   which need an authenticated binary, so it cannot happen on a bare runner.
 *   What it replaces is nothing at all: the accuracy of every `assumed`- and
 *   `documented`-tier rule is bounded by how close the fixtures are to the
 *   shipping binary, and the only thing prompting anyone to re-record was
 *   remembering to.
 *
 * WHY IT ALERTS ON MINOR VERSIONS RATHER THAN EVERY PATCH:
 *
 *   The first version of this compared against the exact patch release. Claude
 *   Code shipped 2.1.233, 2.1.240 and 2.1.245 inside a few days, so that check
 *   was red permanently — and a permanently-red check is one nobody reads. The
 *   relaxation is not a guess: re-recording across 2.1.233 → 2.1.240, seven patch
 *   releases, changed nothing this tool models. Identical hook execution orders,
 *   the same 31 valid hook events, the same trust-gating counts, the same env and
 *   defaultMode resolution. Only the version stamp moved.
 *
 *   So a patch gap is reported and not alerted on; a MINOR gap alerts, because
 *   that is where behaviour realistically changes. A staleness deadline catches
 *   the case where the minor never moves and the fixtures quietly rot anyway.
 *
 * A no-alert result is therefore NOT a claim that behaviour is unchanged. It says
 * nothing has happened that is worth a human's attention yet.
 *
 * Exits 0 whether or not it alerts; the caller decides what to do with the
 * verdict. Exits 2 when it cannot tell, which must never read as "fine".
 *
 * Usage: node scripts/check-conformance-drift.mjs <current-version> [fixture-age-days]
 */

import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Alert regardless of version once the recordings are this old. */
const STALE_AFTER_DAYS = 30;

const current = process.argv[2]?.trim();
const ageDays = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;

if (!current) {
  console.error("usage: node scripts/check-conformance-drift.mjs <current-version> [fixture-age-days]");
  console.error("(get the version with: npm view @anthropic-ai/claude-code version)");
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, "..");
const fixturesRoot = join(repoRoot, "test", "fixtures");

function findRecordings(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findRecordings(full, out);
    else if (entry.endsWith(".json")) out.push(full);
  }
  return out;
}

const stamped = [];
for (const file of findRecordings(fixturesRoot)) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue; // Not every JSON under a fixture is a recording.
  }
  if (typeof parsed?.claudeVersion === "string" && parsed.claudeVersion.length > 0) {
    stamped.push({ file: relative(repoRoot, file).split("\\").join("/"), version: parsed.claudeVersion });
  }
}

// Guarding the guard. Without this, a refactor that moves the fixtures or renames
// the stamp would leave this reporting "no drift" forever while checking nothing —
// the same vacuous-green failure the test-collection assert exists to prevent.
if (stamped.length === 0) {
  console.error("Found no conformance recordings carrying a `claudeVersion` stamp.");
  console.error(`Looked under ${relative(repoRoot, fixturesRoot)}.`);
  console.error("Either the fixtures moved or the stamp was renamed. Cannot determine drift.");
  process.exit(2);
}

const recorded = [...new Set(stamped.map((s) => s.version))].sort();

/** [major, minor, patch]; missing or non-numeric parts become NaN, handled below. */
function parts(v) {
  return String(v).split(".").slice(0, 3).map((n) => Number.parseInt(n, 10));
}
function minorKey(v) {
  const [a, b] = parts(v);
  return Number.isInteger(a) && Number.isInteger(b) ? `${a}.${b}` : null;
}

const currentMinor = minorKey(current);
const recordedMinors = [...new Set(recorded.map(minorKey))];

const mixed = recorded.length > 1;
// An unparseable version on either side is a cannot-tell, not a pass.
const unparseable = currentMinor === null || recordedMinors.includes(null);
const minorMoved = !unparseable && !recordedMinors.includes(currentMinor);
const stale = Number.isFinite(ageDays) && ageDays > STALE_AFTER_DAYS;
const patchBehind = !minorMoved && !unparseable && !recorded.includes(current);

console.log(`Claude Code on npm:  ${current}`);
console.log(`fixtures recorded:   ${recorded.join(", ")}  (${stamped.length} recordings)`);
if (Number.isFinite(ageDays)) console.log(`fixtures last changed: ${ageDays} day(s) ago`);

if (mixed) {
  console.log("");
  console.log("MIXED: not every fixture was recorded against the same version.");
  for (const s of stamped) console.log(`  ${s.version}  ${s.file}`);
}

if (unparseable) {
  console.error("");
  console.error(`Could not parse a major.minor from "${current}" or from the recorded stamps.`);
  console.error("Refusing to report all-clear on a comparison that did not happen.");
  process.exit(2);
}

const reasons = [];
if (minorMoved) reasons.push(`Claude Code moved to ${currentMinor}.x; fixtures describe ${recordedMinors.join(", ")}.x`);
if (mixed) reasons.push(`fixtures are recorded against mixed versions (${recorded.join(", ")})`);
if (stale) reasons.push(`fixtures have not been re-recorded in ${ageDays} days (limit ${STALE_AFTER_DAYS})`);

const drift = reasons.length > 0;
const summary = drift
  ? `Fixtures are recorded against Claude Code ${recorded.join(", ")}; npm ships ${current}. Reason: ${reasons.join("; ")}.`
  : patchBehind
    ? `Fixtures describe ${recorded.join(", ")}, npm ships ${current} — same ${currentMinor}.x line, no action needed.`
    : `Fixtures match the current release (${current}).`;

console.log("");
console.log(drift ? `DRIFT: ${summary}` : `OK: ${summary}`);
if (!drift && patchBehind) {
  console.log(
    "Patch-level gaps are reported, not alerted on: re-recording across seven of them " +
      "(2.1.233 -> 2.1.240) changed nothing this tool models.",
  );
}

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `drift=${drift ? "true" : "false"}\n`);
  appendFileSync(out, `recorded=${recorded.join(",")}\n`);
  appendFileSync(out, `current=${current}\n`);
  appendFileSync(out, `reason=${reasons.join("; ")}\n`);
  appendFileSync(out, `summary=${summary}\n`);
}
