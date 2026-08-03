/**
 * The context-budget model.
 *
 * The naive version of this feature — `wc -c` the whole .claude directory — is
 * worse than not shipping it. Most of what lives under .claude/ is NOT in
 * context on every turn, so summing it produces a scary number that is mostly
 * fiction, and the first user who checks the math stops trusting the tool.
 *
 * So we classify every artifact by how it actually reaches the model:
 *
 *   always       CLAUDE.md hierarchy and its @imports. Loaded every turn.
 *   metadataOnly Skills and subagents contribute only their frontmatter
 *                (name + description) until invoked. Counting their bodies
 *                would overstate the budget, often by an order of magnitude.
 *   onDemand     Slash commands, skill bodies, subdirectory CLAUDE.md files.
 *                Zero cost until used. Reported separately, never summed into
 *                the always-loaded total.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { isDir, isFile, relative } from "../discovery/layers.js";
import { readdirSync } from "node:fs";
import { scanMarkdown } from "../parse/markdown.js";
import type { CountMode, TokenCounter } from "./counter.js";

export type LoadClass = "always" | "metadataOnly" | "onDemand";

export interface BudgetEntry {
  label: string;
  file: string;
  loadClass: LoadClass;
  tokens: number;
  mode: CountMode;
  /** For metadataOnly: how large the artifact is if it were fully loaded. */
  fullTokens?: number;
  note?: string;
}

export interface BudgetReport {
  entries: BudgetEntry[];
  alwaysLoaded: number;
  metadataOnly: number;
  onDemand: number;
  /** alwaysLoaded + metadataOnly — the true per-turn floor. */
  perTurnTotal: number;
  contextWindow: number;
  degradedReason?: string | undefined;
}

/** Context windows we know. Used only to render a percentage. */
export function contextWindowFor(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("[1m]") || m.includes("1m")) return 1_000_000;
  if (m.includes("haiku")) return 200_000;
  if (/opus-5|sonnet-5|fable-5|opus-4-[678]|sonnet-4-6/.test(m)) return 1_000_000;
  return 200_000;
}

export interface BuildBudgetInput {
  projectRoot: string;
  /** Memory files that are always in context, in load order. */
  memoryFiles: { file: string; label: string }[];
  /** Nested CLAUDE.md files — loaded only when Claude touches that subtree. */
  subdirectoryMemory: string[];
  claudeDirs: string[];
  contextWindow: number;
}

export async function buildBudget(
  input: BuildBudgetInput,
  counter: TokenCounter,
): Promise<BudgetReport> {
  const entries: BudgetEntry[] = [];
  const seen = new Set<string>();

  // --- always-loaded memory, following @imports transitively ---------------
  for (const memory of input.memoryFiles) {
    for (const file of expandImports(memory.file, seen)) {
      const text = safeRead(file);
      if (text === undefined) continue;
      const { tokens, mode } = await counter.count(text);
      entries.push({
        label: file === memory.file ? memory.label : `${memory.label} → @${relative(input.projectRoot, file)}`,
        file,
        loadClass: "always",
        tokens,
        mode,
      });
    }
  }

  // --- skills and subagents: frontmatter only ------------------------------
  for (const dir of input.claudeDirs) {
    for (const skill of listSkills(dir)) {
      const text = safeRead(skill);
      if (text === undefined) continue;
      const fm = frontmatter(text);
      const advertised = [fm["name"] ?? basename(dirname(skill)), fm["description"] ?? ""]
        .filter(Boolean)
        .join(": ");
      const { tokens, mode } = await counter.count(advertised);
      const full = await counter.count(text);
      entries.push({
        label: `skill: ${fm["name"] ?? basename(dirname(skill))}`,
        file: skill,
        loadClass: "metadataOnly",
        tokens,
        mode,
        fullTokens: full.tokens,
        note: "only name + description are in context until the skill is invoked",
      });
    }

    for (const agent of listMarkdown(join(dir, "agents"))) {
      const text = safeRead(agent);
      if (text === undefined) continue;
      const fm = frontmatter(text);
      const advertised = [fm["name"] ?? basename(agent, ".md"), fm["description"] ?? ""]
        .filter(Boolean)
        .join(": ");
      const { tokens, mode } = await counter.count(advertised);
      const full = await counter.count(text);
      entries.push({
        label: `agent: ${fm["name"] ?? basename(agent, ".md")}`,
        file: agent,
        loadClass: "metadataOnly",
        tokens,
        mode,
        fullTokens: full.tokens,
        note: "only the description is in context until the agent is spawned",
      });
    }

    for (const command of listMarkdown(join(dir, "commands"))) {
      const text = safeRead(command);
      if (text === undefined) continue;
      const { tokens, mode } = await counter.count(text);
      entries.push({
        label: `command: /${basename(command, ".md")}`,
        file: command,
        loadClass: "onDemand",
        tokens,
        mode,
        note: "not loaded until the command is run",
      });
    }
  }

  // --- subdirectory CLAUDE.md ----------------------------------------------
  for (const file of input.subdirectoryMemory) {
    const text = safeRead(file);
    if (text === undefined) continue;
    const { tokens, mode } = await counter.count(text);
    entries.push({
      label: `nested: ${relative(input.projectRoot, file)}`,
      file,
      loadClass: "onDemand",
      tokens,
      mode,
      note: "loaded only when Claude works inside this subtree",
    });
  }

  const sum = (cls: LoadClass) =>
    entries.filter((e) => e.loadClass === cls).reduce((n, e) => n + e.tokens, 0);

  const alwaysLoaded = sum("always");
  const metadataOnly = sum("metadataOnly");
  const onDemand = sum("onDemand");

  return {
    entries,
    alwaysLoaded,
    metadataOnly,
    onDemand,
    perTurnTotal: alwaysLoaded + metadataOnly,
    contextWindow: input.contextWindow,
    degradedReason: counter.degradedReason,
  };
}

/**
 * Follow `@path` imports transitively. Claude Code bounds import depth; we
 * bound it too and guard against cycles, which people do create by accident.
 */
export function expandImports(entry: string, seen: Set<string>, depth = 0): string[] {
  const resolved = resolve(entry);
  if (seen.has(resolved) || depth > 5) return [];
  seen.add(resolved);

  const out = [resolved];
  const text = safeRead(resolved);
  if (text === undefined) return out;

  for (const imp of scanMarkdown(text).imports) {
    const target = isAbsolute(imp.target)
      ? imp.target
      : resolve(dirname(resolved), imp.target);
    if (!isFile(target)) continue; // dead imports are reported by a lint rule
    out.push(...expandImports(target, seen, depth + 1));
  }
  return out;
}

/** Minimal YAML frontmatter reader — we only need flat string scalars. */
export function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match?.[1]) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    let value = (kv[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[kv[1]] = value;
  }
  return out;
}

function listSkills(claudeDir: string): string[] {
  const skillsDir = join(claudeDir, "skills");
  if (!isDir(skillsDir)) return [];
  const out: string[] = [];
  for (const name of safeReaddir(skillsDir)) {
    const candidate = join(skillsDir, name, "SKILL.md");
    if (isFile(candidate)) out.push(candidate);
  }
  return out;
}

function listMarkdown(dir: string): string[] {
  if (!isDir(dir)) return [];
  return safeReaddir(dir)
    .filter((n) => n.endsWith(".md"))
    .map((n) => join(dir, n))
    .filter(isFile);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeRead(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
