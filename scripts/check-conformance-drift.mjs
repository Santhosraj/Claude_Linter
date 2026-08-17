/**
 * Reports whether the recorded conformance fixtures still describe the current
 * Claude Code release.
 *
 * WHAT THIS DOES AND DOES NOT DO, because the difference matters:
 *
 *   It detects the TRIGGER for re-recording — a new Claude Code version — not
 *   behaviour drift itself. Actually re-deriving the expectations means running
 *   `claude -p` and `claude --debug`, which need an authenticated binary, so it
 *   cannot happen on a bare runner. What this replaces is nothing at all: the
 *   accuracy of every `assumed`- and `documented`-tier rule is bounded by how
 *   close the fixtures are to the shipping binary, and until now the only thing
 *   prompting anyone to re-record was remembering to.
 *
 * A version match is therefore NOT a claim that behaviour is unchanged within a
 * version — it is a claim that nobody needs to re-record yet.
 *
 * Exits 0 whether or not there is drift; the caller decides what to do with the
 * verdict. Exits 2 when it cannot tell, which must never be mistaken for "fine".
 *
 * Usage: node scripts/check-conformance-drift.mjs <current-claude-version>
 */

import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const current = process.argv[2]?.trim();
if (!current) {
  console.error("usage: node scripts/check-conformance-drift.mjs <current-claude-version>");
  console.error("(get it with: npm view @anthropic-ai/claude-code version)");
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, "..");
const fixturesRoot = join(repoRoot, "test", "fixtures");

/** Every recording that stamps the binary version it was derived from. */
function findRecordings(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findRecordings(full, out);
    } else if (entry.endsWith(".json")) {
      out.push(full);
    }
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
  const version = parsed?.claudeVersion;
  if (typeof version === "string" && version.length > 0) {
    stamped.push({ file: relative(repoRoot, file).replace(/\\/g, "/"), version });
  }
}

// Guarding the guard. If a refactor moves the recordings or renames the stamp,
// this script would otherwise report "no drift" forever while checking nothing —
// the same vacuous-green failure the collection assert exists to prevent.
if (stamped.length === 0) {
  console.error("Found no conformance recordings carrying a `claudeVersion` stamp.");
  console.error(`Looked under ${relative(repoRoot, fixturesRoot)}.`);
  console.error("Either the fixtures moved or the stamp was renamed. Cannot determine drift.");
  process.exit(2);
}

const recorded = [...new Set(stamped.map((s) => s.version))].sort();
const drift = !(recorded.length === 1 && recorded[0] === current);

console.log(`Claude Code on npm:  ${current}`);
console.log(`fixtures recorded:   ${recorded.join(", ")}  (${stamped.length} recordings)`);

// Mixed stamps mean a partial re-record — some expectations describe one binary
// and some another, which is worse than being uniformly behind.
if (recorded.length > 1) {
  console.log("");
  console.log("MIXED: not every fixture was recorded against the same version.");
  for (const s of stamped) console.log(`  ${s.version}  ${s.file}`);
}

const summary = drift
  ? recorded.length > 1
    ? `Fixtures are recorded against mixed versions (${recorded.join(", ")}); npm ships ${current}.`
    : `Fixtures are recorded against Claude Code ${recorded[0]}; npm ships ${current}.`
  : `Fixtures match the current release (${current}).`;

console.log("");
console.log(drift ? `DRIFT: ${summary}` : `OK: ${summary}`);

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `drift=${drift ? "true" : "false"}\n`);
  appendFileSync(out, `recorded=${recorded.join(",")}\n`);
  appendFileSync(out, `current=${current}\n`);
  appendFileSync(out, `summary=${summary}\n`);
}
