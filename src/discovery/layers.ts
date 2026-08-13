/**
 * Locate every config layer on disk.
 *
 * Discovery is intentionally separate from parsing and resolution so the
 * conformance harness can point the resolver at a synthetic filesystem
 * (fixtures with their own fake HOME) instead of the developer's real machine.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import type { LayerKind, MemoryLayer } from "../model/types.js";

export interface DiscoveryOptions {
  /** Where to start searching for the project root. Defaults to cwd. */
  cwd?: string;
  /**
   * Force the project root, skipping detection entirely. The escape hatch for
   * layouts the marker heuristic reads wrong — and worth preferring in CI, where
   * an explicit root beats a guess that can shift when a file is added.
   */
  projectRoot?: string;
  /** Override the home directory — used by fixtures to sandbox discovery. */
  home?: string;
  /** Override the enterprise managed-policy path. */
  managedPolicyPath?: string;
}

export interface DiscoveredFile {
  file: string;
  layer: LayerKind;
}

export interface DiscoveredMemory {
  file: string;
  layer: MemoryLayer;
}

/** Why the project root is what it is — surfaced by `doctor`. */
export interface RootProvenance {
  root: string;
  /** The marker file/dir that decided it, when detection was used. */
  marker?: string;
  source: "forced" | "strong" | "weak" | "fallback";
}

/**
 * Whether Claude Code considers this workspace trusted.
 *
 * This is not a detail: **project-layer `permissions.allow` entries are ignored
 * entirely in an untrusted workspace.** Verified against the binary, which says
 * so out loud:
 *
 *   Ignoring 2 permissions.allow entries from .claude/settings.json:
 *   this workspace has not been trusted.
 *
 * The gating is narrow, and the boundaries were each verified separately
 * because getting them wrong is dangerous in both directions:
 *
 *   - project-layer `allow`  — GATED (ignored until trusted)
 *   - user-layer `allow`     — not gated
 *   - `deny` and `ask`       — not gated, at any layer
 *
 * That asymmetry is security-correct: dropping an `allow` falls back to
 * prompting, whereas dropping a `deny` would silently remove a guard.
 */
export interface WorkspaceTrust {
  /** `undefined` when we could not read the trust store at all. */
  trusted: boolean | undefined;
  /** The `~/.claude.json` projects key that matched, for reporting. */
  matchedKey?: string;
  /**
   * The path Claude Code keys trust on — the **enclosing git root**, which is
   * not always our `projectRoot`.
   *
   * `.claude` is a strong root marker here, so a directory carrying one becomes
   * our root even when a `.git` sits above it. The binary keeps walking to the
   * git root, verified by repeated probes of 2.1.229 from a directory below one:
   * it asks for `projects["<git root>"]`, not the directory it is running in.
   *
   * Keying the lookup on `projectRoot` therefore read the wrong entry, and the
   * remediation line told people to write a key the binary never reads —
   * following the advice exactly would leave the warning in place, which is
   * worse than no advice.
   *
   * Optional so fixture-built contexts stay valid; readers should fall back to
   * `projectRoot`.
   */
  key?: string;
}

export interface Discovery {
  projectRoot: string;
  workspaceTrust: WorkspaceTrust;
  /**
   * How the root was chosen. Reporting this is not cosmetic: a wrong root makes
   * every downstream number wrong in a way that still looks self-consistent, so
   * the user needs to be able to sanity-check it at a glance.
   */
  rootProvenance: RootProvenance;
  /** Where discovery was asked to start, which may differ from the root. */
  startedFrom: string;
  home: string;
  settings: DiscoveredFile[];
  memory: DiscoveredMemory[];
  mcp: DiscoveredFile[];
  /** Directories scanned for skills/commands/agents, for the token report. */
  claudeDirs: string[];
}

/** Enterprise managed policy lives at a fixed OS-specific path. */
export function managedPolicyPathFor(os: NodeJS.Platform = platform()): string {
  switch (os) {
    case "win32":
      return join(
        process.env["PROGRAMDATA"] ?? "C:\\ProgramData",
        "ClaudeCode",
        "managed-settings.json",
      );
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    default:
      return "/etc/claude-code/managed-settings.json";
  }
}

/**
 * Directories that unambiguously mark a project root. `.git` bounds a
 * repository; `.claude` is where project-scoped Claude config lives.
 */
const STRONG_MARKERS = [".git", ".claude"];

/**
 * Files that indicate "a Claude Code project lives here" but are ALSO valid in
 * a subdirectory — a nested `CLAUDE.md` is ordinary subtree memory, not a root.
 */
const WEAK_MARKERS = ["CLAUDE.md", "CLAUDE.local.md", ".mcp.json", ".cclint.json"];

/**
 * Find the project root by walking up from `start`.
 *
 * Marker strength is the whole subtlety here. Treating a bare `CLAUDE.md` as a
 * root marker with equal weight would break monorepos: running from
 * `repo/packages/api` (which has its own nested `CLAUDE.md`) would resolve the
 * root to that package instead of `repo`, so the real project settings and the
 * root CLAUDE.md would both vanish from discovery.
 *
 * So: strong markers win at any depth, and weak markers are only consulted when
 * no strong marker exists anywhere up the tree — which is exactly the scratch
 * folder case (a directory holding just a CLAUDE.md, no git, no .claude).
 */
export function findProjectRoot(start: string, home?: string): string {
  return findProjectRootDetailed(start, home).root;
}

export function findProjectRootDetailed(start: string, home?: string): RootProvenance {
  const from = resolve(start);

  /**
   * The upward walk stops here, and these directories are never roots.
   *
   * Both the caller-supplied home AND the machine's real home are boundaries.
   * `~/.claude` is the USER config layer by definition — treating it as a
   * project marker made every non-git folder under $HOME resolve its root to
   * $HOME, which then discovered ~/.claude/settings.json as both the user and
   * the project layer and reported it as shadowing itself.
   *
   * The real home matters even when a test or fixture overrides `home`: a
   * fixture in a temp directory still sits somewhere under the real $HOME on
   * most platforms, and without this the walk escapes past it and lands on the
   * developer's own config.
   */
  const boundaries = new Set([resolve(home ?? homedir()), resolve(homedir())]);

  let weak: { dir: string; marker: string } | undefined;
  let dir = from;

  for (;;) {
    if (boundaries.has(dir)) break;

    for (const marker of STRONG_MARKERS) {
      if (existsSync(join(dir, marker))) {
        return { root: dir, marker, source: "strong" };
      }
    }
    if (weak === undefined) {
      for (const marker of WEAK_MARKERS) {
        if (isFile(join(dir, marker))) {
          weak = { dir, marker };
          break;
        }
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // No .git or .claude below the boundary. Fall back to the nearest
  // Claude-ish file, then to where we were asked to start.
  if (weak) return { root: weak.dir, marker: weak.marker, source: "weak" };
  return { root: from, source: "fallback" };
}

export function discover(options: DiscoveryOptions = {}): Discovery {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const rootProvenance: RootProvenance = options.projectRoot
    ? { root: resolve(options.projectRoot), source: "forced" }
    : findProjectRootDetailed(cwd, home);
  const projectRoot = rootProvenance.root;

  /**
   * One physical file must never occupy two layers.
   *
   * If the project root ever coincides with $HOME — reachable via an explicit
   * --project-root, or a future marker change — then the user and project
   * settings paths are the SAME file, and admitting it twice makes the resolver
   * report it as shadowing itself: a fabricated finding pointing at a file whose
   * only mistake was existing. The lowest-precedence claim wins, since that is
   * the layer the path genuinely belongs to.
   */
  const claimed = new Set<string>();

  const settings: DiscoveredFile[] = [];
  const push = (file: string, layer: LayerKind) => {
    const key = resolve(file);
    if (claimed.has(key)) return;
    if (!isFile(file)) return;
    claimed.add(key);
    settings.push({ file, layer });
  };

  push(join(home, ".claude", "settings.json"), "user");
  push(join(projectRoot, ".claude", "settings.json"), "projectShared");
  push(join(projectRoot, ".claude", "settings.local.json"), "projectLocal");

  const policyPath = options.managedPolicyPath ?? managedPolicyPathFor();
  push(policyPath, "managedPolicy");

  // --- memory (CLAUDE.md) ---------------------------------------------------
  const memory: DiscoveredMemory[] = [];
  const claimedMemory = new Set<string>();
  const pushMemory = (file: string, layer: MemoryLayer) => {
    const key = resolve(file);
    if (claimedMemory.has(key)) return;
    if (!isFile(file)) return;
    claimedMemory.add(key);
    memory.push({ file, layer });
    return;
  };

  pushMemory(join(home, ".claude", "CLAUDE.md"), "user");
  pushMemory(join(projectRoot, "CLAUDE.md"), "project");
  pushMemory(join(projectRoot, ".claude", "CLAUDE.md"), "project");
  pushMemory(join(projectRoot, "CLAUDE.local.md"), "project");

  // Subdirectory CLAUDE.md files are loaded on demand when Claude touches that
  // subtree, so they are reported separately — they are NOT always in context,
  // and counting them in the always-loaded budget would inflate the number.
  for (const file of findSubdirectoryMemory(projectRoot)) {
    pushMemory(file, "subdirectory");
  }

  // --- MCP ------------------------------------------------------------------
  const mcp: DiscoveredFile[] = [];
  const claimedMcp = new Set<string>();
  const pushMcp = (file: string, layer: LayerKind) => {
    const key = resolve(file);
    if (claimedMcp.has(key) || !isFile(file)) return;
    claimedMcp.add(key);
    mcp.push({ file, layer });
  };
  pushMcp(join(projectRoot, ".mcp.json"), "projectShared");
  pushMcp(join(home, ".claude.json"), "user");

  const claudeDirs = [...new Set([join(home, ".claude"), join(projectRoot, ".claude")])].filter(
    isDir,
  );

  return {
    projectRoot,
    workspaceTrust: readWorkspaceTrust(home, projectRoot),
    rootProvenance,
    startedFrom: cwd,
    home,
    settings,
    memory,
    mcp,
    claudeDirs,
  };
}

/**
 * Walk the project for nested CLAUDE.md files, skipping the usual heavy
 * directories. Bounded in depth so a monorepo scan stays fast.
 */
function findSubdirectoryMemory(root: string, maxDepth = 4): string[] {
  const skip = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    "target",
    "vendor",
    ".claude",
  ]);
  const found: string[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable directory (permissions, race) — skip, never crash
    }
    for (const name of entries) {
      if (skip.has(name) || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (!isDir(full)) continue;
      const candidate = join(full, "CLAUDE.md");
      if (isFile(candidate)) found.push(candidate);
      walk(full, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}

/**
 * Read the workspace trust flag from `~/.claude.json`.
 *
 * Key matching is case- and separator-insensitive on purpose: a real store
 * contains BOTH `d:/internship/...` and `D:/internship/...` as distinct keys
 * for the same directory, so an exact string compare would report a trusted
 * workspace as untrusted roughly half the time.
 */
export function readWorkspaceTrust(home: string, projectRoot: string): WorkspaceTrust {
  // Trust is keyed on the git root, not on our project root. See WorkspaceTrust.
  const key = trustKeyFor(projectRoot);
  const store = join(home, ".claude.json");

  // No store at all means no workspace has ever been trusted, which is a
  // definite `false` — and matches the binary, which ignores project allow
  // entries in exactly this situation. Only an unreadable or malformed store is
  // genuinely unknown; guessing there would risk telling someone their
  // permissions are being ignored when we simply could not tell.
  if (!isFile(store)) return { trusted: false, key };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(store, "utf8"));
  } catch {
    return { trusted: undefined, key };
  }

  const projects =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["projects"]
      : undefined;

  // A store with no projects map is well-formed and simply records no trusted
  // workspaces.
  if (typeof projects !== "object" || projects === null) return { trusted: false, key };

  const want = normalizeProjectKey(key);
  const matches: { candidate: string; flag: boolean }[] = [];
  for (const [candidate, value] of Object.entries(projects as Record<string, unknown>)) {
    if (normalizeProjectKey(candidate) !== want) continue;
    if (typeof value !== "object" || value === null) continue;
    const flag = (value as Record<string, unknown>)["hasTrustDialogAccepted"];
    if (typeof flag === "boolean") matches.push({ candidate, flag });
  }

  // A project with no entry has never been opened interactively, so it has not
  // been trusted. That is a definite `false`, not an unknown.
  if (matches.length === 0) return { trusted: false, key };

  /**
   * Duplicate keys for one directory can DISAGREE. A real store on the machine
   * this was written on holds both `D:/…/Claude_linter` (true) and
   * `d:/…/Claude_linter` (false) — the case-insensitive match finds both.
   *
   * Returning the first hit made the verdict depend on object key order, which
   * is insertion order and has nothing to do with which entry the binary reads.
   * It happened to pick the right one here; a store written in the other order
   * would have produced a confident false positive telling someone their allow
   * list was dead. Two answers is not an answer, so this reports `undefined` —
   * which the permission rule already treats as "say nothing about trust".
   */
  const distinct = new Set(matches.map((m) => m.flag));
  if (distinct.size > 1) return { trusted: undefined, key };

  return { trusted: matches[0]!.flag, matchedKey: matches[0]!.candidate, key };
}

/**
 * The path Claude Code keys workspace trust on: the enclosing git root, or
 * `projectRoot` when the tree is not a git repository.
 *
 * `.git` is matched as a file as well as a directory — it is a file containing a
 * `gitdir:` pointer in a worktree or submodule, and treating those as "not a
 * repository" would silently fall back to the wrong key for anyone using them.
 */
export function trustKeyFor(projectRoot: string): string {
  let dir = resolve(projectRoot);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return projectRoot; // hit the filesystem root
    dir = parent;
  }
}

function normalizeProjectKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readText(p: string): string {
  return readFileSync(p, "utf8");
}

/** Display paths relative to the project root so output stays readable. */
export function relative(root: string, file: string): string {
  const r = resolve(root);
  const f = resolve(file);
  return f.startsWith(r + sep) ? f.slice(r.length + 1) : f;
}
