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
  /** Directory to treat as the project root. Defaults to cwd. */
  cwd?: string;
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

export interface Discovery {
  projectRoot: string;
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

export function findProjectRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".claude")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start); // no marker found; use where we started
    dir = parent;
  }
}

export function discover(options: DiscoveryOptions = {}): Discovery {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const projectRoot = findProjectRoot(cwd);

  const settings: DiscoveredFile[] = [];
  const push = (file: string, layer: LayerKind) => {
    if (isFile(file)) settings.push({ file, layer });
  };

  push(join(home, ".claude", "settings.json"), "user");
  push(join(projectRoot, ".claude", "settings.json"), "projectShared");
  push(join(projectRoot, ".claude", "settings.local.json"), "projectLocal");

  const policyPath = options.managedPolicyPath ?? managedPolicyPathFor();
  push(policyPath, "managedPolicy");

  // --- memory (CLAUDE.md) ---------------------------------------------------
  const memory: DiscoveredMemory[] = [];
  const pushMemory = (file: string, layer: MemoryLayer) => {
    if (isFile(file)) memory.push({ file, layer });
  };

  pushMemory(join(home, ".claude", "CLAUDE.md"), "user");
  pushMemory(join(projectRoot, "CLAUDE.md"), "project");
  pushMemory(join(projectRoot, ".claude", "CLAUDE.md"), "project");
  pushMemory(join(projectRoot, "CLAUDE.local.md"), "project");

  // Subdirectory CLAUDE.md files are loaded on demand when Claude touches that
  // subtree, so they are reported separately — they are NOT always in context,
  // and counting them in the always-loaded budget would inflate the number.
  for (const file of findSubdirectoryMemory(projectRoot)) {
    memory.push({ file, layer: "subdirectory" });
  }

  // --- MCP ------------------------------------------------------------------
  const mcp: DiscoveredFile[] = [];
  const projectMcp = join(projectRoot, ".mcp.json");
  if (isFile(projectMcp)) mcp.push({ file: projectMcp, layer: "projectShared" });
  const userMcp = join(home, ".claude.json");
  if (isFile(userMcp)) mcp.push({ file: userMcp, layer: "user" });

  const claudeDirs = [join(home, ".claude"), join(projectRoot, ".claude")].filter(isDir);

  return { projectRoot, home, settings, memory, mcp, claudeDirs };
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
