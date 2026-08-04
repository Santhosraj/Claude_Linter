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

export interface Discovery {
  projectRoot: string;
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
