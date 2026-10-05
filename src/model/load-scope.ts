/**
 * When are two memory files in context at the same time?
 *
 * Every pairing rule — duplicates, axis conflicts, the semantic prefilter — has
 * to ask this before it reports anything, and they must agree. They used to
 * assume every CLAUDE.md is loaded every turn, while the budget module (rightly)
 * modelled subdirectory files as on demand. So a project whose root is one large
 * repository reported a rule in `clients/a/CLAUDE.md` as "already stated in
 * another CLAUDE.md that is also always in context" — `clients/b/CLAUDE.md`, a
 * different project that Claude Code never loads while working in the first.
 */

import { isAbsolute, relative, resolve } from "node:path";

import type { MemorySource } from "./types.js";

/** Both files load every turn. */
export const ALWAYS = "always" as const;

/**
 * Where both files are in context, if anywhere:
 *
 *   `ALWAYS`     both load every turn
 *   a directory  both load while Claude works under it — the deeper of the two
 *                scopes, since an always-loaded file is present everywhere
 *   `undefined`  never by working in one place: they sit in sibling subtrees
 */
export function sharedLoadScope(
  a: string | undefined,
  b: string | undefined,
): typeof ALWAYS | string | undefined {
  if (a === undefined && b === undefined) return ALWAYS;
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (within(b, a)) return b;
  if (within(a, b)) return a;
  return undefined;
}

/** Is `child` the same directory as `parent`, or inside it? */
function within(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Look up a file's load scope by path, as rules only carry their file. */
export function loadScopeIndex(memory: MemorySource[]): (file: string) => string | undefined {
  const byFile = new Map(memory.map((m) => [resolve(m.file), m.loadScope]));
  return (file) => byFile.get(resolve(file));
}
