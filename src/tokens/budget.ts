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
import { SEVERITY } from "../rules/context.js";
import type { Diagnostic } from "../model/types.js";
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
  /** False when `contextWindow` was assumed because the model was unrecognised. */
  contextWindowKnown?: boolean;
  /** The model the window was resolved from. */
  model?: string;
  degradedReason?: string | undefined;
}

/**
 * Always-loaded tokens at which the cost is worth mentioning.
 *
 * A threshold is a judgment call, so this one is deliberately high. Running over
 * a real project surfaced a 16,274-token `CLAUDE.md` — paid on every turn, for
 * the life of the project — while the lint printed "No issues found" and left the
 * number in a separate block the reader had already scrolled past. That gap is
 * the tool's own headline pitch going unreported.
 *
 * 10,000 is chosen to be plainly defensible rather than tuned: it is far above a
 * thorough CLAUDE.md (the sample fixtures sit in the hundreds) and far below the
 * point where anyone would call it fine. Being `info` and off by default is what
 * makes the number safe to be roughly right — nobody's build breaks on it.
 */
const ALWAYS_LOADED_NOTABLE = 10_000;

/**
 * The always-loaded context is large enough to be worth a line in the findings.
 *
 * Deliberately NOT an error or a warning. Nothing here is broken, a big
 * CLAUDE.md can be entirely intentional, and severity in this project means
 * something: `error` is reserved for what the bytes prove, and this is a
 * judgment about cost. It rides with `--strict`.
 */
export function budgetDiagnostics(report: BudgetReport, projectRoot: string): Diagnostic[] {
  if (report.alwaysLoaded < ALWAYS_LOADED_NOTABLE) return [];

  const always = report.entries
    .filter((e) => e.loadClass === "always")
    .sort((a, b) => b.tokens - a.tokens);

  const biggest = always[0];
  if (!biggest) return [];

  // Two decimals, matching the budget block in report/text.ts. They render the
  // same quantity on the same screen, and `1.6%` beside `1.63%` reads as two
  // different measurements rather than one rounded twice.
  const share = ((report.alwaysLoaded / report.contextWindow) * 100).toFixed(2);
  const estimated = biggest.mode !== "exact";

  return [
    {
      ruleId: "memory/large-always-loaded",
      severity: SEVERITY.heuristic,
      heuristic: true,
      message:
        `${estimated ? "~" : ""}${report.alwaysLoaded.toLocaleString()} tokens are loaded on ` +
        `every turn (${share}% of the context window).`,
      file: biggest.file,
      detail: [
        // Only worth listing when the cost is split across files. With one
        // contributor the line repeats the message and the file above it.
        ...(always.length > 1
          ? [
              ...always
                .slice(0, 3)
                .map(
                  (e) =>
                    `${estimated ? "~" : ""}${e.tokens.toLocaleString()}  ` +
                    relative(projectRoot, e.file),
                ),
              ...(always.length > 3
                ? [`… and ${always.length - 3} more always-loaded file(s)`]
                : []),
            ]
          : []),
        "This is a floor, not a total: it is spent before your prompt, on every turn.",
        "Content only some tasks need can move to a nested CLAUDE.md or a skill, which",
        "load on demand instead.",
      ],
      data: {
        alwaysLoaded: report.alwaysLoaded,
        contextWindow: report.contextWindow,
        estimated,
      },
    },
  ];
}

/**
 * Context windows, by model. Used only to render the per-turn floor as a
 * percentage of the window.
 *
 * Ordered, first match wins, and deliberately a table rather than one regex: the
 * previous single expression omitted `claude-mythos-5` (1M), which silently
 * resolved to the 200K fallback and inflated every reported share fivefold.
 *
 * A `[1m]` suffix is a deployment variant of a 1M model rather than a model ID —
 * it appears in real user settings (`opus[1m]`), so it is matched explicitly. The
 * bare-`1m` substring the old code also accepted is gone: it would match any
 * future ID containing those characters.
 */
const CONTEXT_WINDOWS: { pattern: RegExp; tokens: number }[] = [
  { pattern: /\[1m\]/, tokens: 1_000_000 },
  // Haiku is checked before the 1M families so a future `haiku` variant cannot
  // fall through to them.
  { pattern: /haiku/, tokens: 200_000 },
  { pattern: /fable-5|mythos-5|opus-5|sonnet-5/, tokens: 1_000_000 },
  { pattern: /opus-4-[678]|sonnet-4-6/, tokens: 1_000_000 },
];

/**
 * What cclint assumes when it does not recognise the model.
 *
 * 200K is the smaller of the two live windows, so an unknown model's share is
 * over-reported rather than under-reported — the safer direction for a number
 * whose purpose is to make cost visible. It is still a guess, which is why
 * `resolveContextWindow` reports whether it was used.
 */
const ASSUMED_CONTEXT_WINDOW = 200_000;

export interface ResolvedContextWindow {
  tokens: number;
  /** False when the model matched no entry and the fallback was assumed. */
  known: boolean;
}

/**
 * Resolve a model's context window, saying whether it was actually known.
 *
 * The distinction matters in both directions, and cclint could previously report
 * neither. A model released after this table was written falls to 200K and its
 * share is overstated; meanwhile a project that sets no `model` at all is
 * analysed as the 1M default, so someone genuinely running Haiku sees a share
 * five times too small. Labelling the assumption is the honest fix — inventing a
 * more elaborate guess is not.
 */
export function resolveContextWindow(model: string): ResolvedContextWindow {
  const m = model.toLowerCase();
  for (const { pattern, tokens } of CONTEXT_WINDOWS) {
    if (pattern.test(m)) return { tokens, known: true };
  }
  return { tokens: ASSUMED_CONTEXT_WINDOW, known: false };
}

/** Context window in tokens. Prefer `resolveContextWindow` — it reports guesses. */
export function contextWindowFor(model: string): number {
  return resolveContextWindow(model).tokens;
}

export interface BuildBudgetInput {
  projectRoot: string;
  /** Memory files that are always in context, in load order. */
  memoryFiles: { file: string; label: string }[];
  /** Nested CLAUDE.md files — loaded only when Claude touches that subtree. */
  subdirectoryMemory: string[];
  claudeDirs: string[];
  contextWindow: number;
  /**
   * False when `contextWindow` is the assumed fallback rather than a known
   * value. Reported so the percentage can say so instead of implying certainty.
   */
  contextWindowKnown?: boolean;
  /** The model the window was resolved from, for the caveat text. */
  model?: string;
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
    ...(input.contextWindowKnown === false ? { contextWindowKnown: false } : {}),
    ...(input.model ? { model: input.model } : {}),
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
