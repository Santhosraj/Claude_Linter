import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");

const SEARCHED_DIRS = ["src", "test", "scripts"];
const SEARCHED_EXTS = new Set([".ts", ".md", ".json", ".yml"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Recorded conformance output is data, not source, and is compared
      // byte-for-byte against the binary — never rewrite it for tidiness.
      if (entry === "node_modules" || entry === ".conformance") continue;
      walk(full, out);
      continue;
    }
    if (SEARCHED_EXTS.has(extname(entry))) out.push(full);
  }
  return out;
}

/**
 * A control byte in a source file is invisible in an editor and breaks the tools
 * you would use to find it. ripgrep classifies any file containing a NUL as
 * binary and SKIPS it — silently, with no warning and no match. Two files here
 * did: permissions.ts (the largest rule file) and adjudicate.ts (the entire
 * semantic shell), both because a key separator was written as a literal NUL
 * instead of an escape. Every `grep` across `src/` had been quietly excluding
 * them, which is the worst possible failure mode for a search: confident silence.
 *
 * The fix is a two-character escape that compiles to the identical string, so
 * there is never a reason to embed the raw byte.
 */
describe("source hygiene", () => {
  const files = SEARCHED_DIRS.flatMap((d) => walk(join(repoRoot, d)));

  it("finds source files to check", () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(20);
  });

  it("contains no NUL or other control bytes that make a file unsearchable", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        // Tab, LF and CR are legitimate; everything else below 0x20 is not,
        // and 0x7f (DEL) is never intentional either.
        if (code === 9 || code === 10 || code === 13) continue;
        if (code < 32 || code === 127) {
          const line = text.slice(0, i).split("\n").length;
          offenders.push(
            `${relative(repoRoot, file)}:${line} contains 0x${code.toString(16).padStart(2, "0")}`,
          );
          break;
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
