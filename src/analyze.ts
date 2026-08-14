/**
 * Orchestration: discovery → parse → resolve → rules → budget.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { discover, isFile, relative as relativePath, type DiscoveryOptions } from "./discovery/layers.js";
import { parseAxes, BUILTIN_AXES, type Axis } from "./rules/axes.js";
import { hookRules } from "./rules/hooks.js";
import { mcpRules } from "./rules/mcp.js";
import { memoryRules } from "./rules/memory.js";
import { permissionRules } from "./rules/permissions.js";
import { settingsRules } from "./rules/settings.js";
import { resolveSettings, type LayerInput } from "./resolve/settings.js";
import { scanMarkdown, toRules } from "./parse/markdown.js";
import { SemanticAdjudicator } from "./semantic/adjudicate.js";
import { buildCandidatePairs } from "./semantic/prefilter.js";
import {
  buildBudget,
  budgetDiagnostics,
  contextWindowFor,
  expandImports,
  type BudgetReport,
} from "./tokens/budget.js";
import { TokenCounter } from "./tokens/counter.js";
import type { Diagnostic, MemorySource, Severity } from "./model/types.js";
import type { RuleContext } from "./rules/context.js";

export interface AnalyzeOptions extends DiscoveryOptions {
  offline?: boolean;
  model?: string;
  contextWindow?: number;
  /** Include heuristic (info-tier) findings. */
  strict?: boolean;
  /** Skip the token/budget pass entirely. */
  skipBudget?: boolean;
  apiKey?: string;
  /** Opt in to LLM adjudication of candidate rule conflicts. */
  semantic?: boolean;
  semanticModel?: string;
  semanticProvider?: string | undefined;
  semanticBaseUrl?: string | undefined;
  semanticMaxPairs?: number;
}

export interface LintConfig {
  /** Rule ids to silence entirely. */
  ignore?: string[];
  /** Per-rule severity overrides. */
  severity?: Record<string, Severity | "off">;
  /**
   * Project-relative globs to drop from discovery entirely — `*` matches within
   * a path segment, `**` across segments.
   *
   * Needed by any repo that keeps example or fixture config under version
   * control: those files are real CLAUDE.md and .mcp.json files, so discovery is
   * right to find them, but they describe a test scenario rather than this
   * project and linting them is pure noise.
   */
  excludePaths?: string[];
  axes?: unknown;
  model?: string;
  contextWindow?: number;
}

/** Convert a simple `*` / `**` glob into an anchored regex. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("/")
    .map((segment) =>
      segment === "**"
        ? "\u0000DOUBLE\u0000"
        : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
    )
    .join("/");

  // `a/**/b` must also match `a/b`, so the separator is folded into the wildcard.
  const pattern = escaped
    .replace(/\/\u0000DOUBLE\u0000\//g, "(?:/.*)?/")
    .replace(/\u0000DOUBLE\u0000\//g, "(?:.*/)?")
    .replace(/\/\u0000DOUBLE\u0000/g, "(?:/.*)?")
    .replace(/\u0000DOUBLE\u0000/g, ".*");

  return new RegExp(`^${pattern}$`);
}

function makeExcluder(root: string, globs: string[] | undefined): (file: string) => boolean {
  if (!globs || globs.length === 0) return () => false;
  const patterns = globs.map(globToRegExp);
  return (file: string) => {
    const rel = relativePath(root, file).split("\\").join("/");
    return patterns.some((p) => p.test(rel));
  };
}

export interface AnalysisResult {
  diagnostics: Diagnostic[];
  budget?: BudgetReport;
  context: RuleContext;
  config: LintConfig;
  counts: Record<Severity, number>;
  semantic?: SemanticSummary;
}

export interface SemanticSummary {
  candidatePairs: number;
  /** Pairs skipped because the run stopped early. Never leave this implicit. */
  unexamined?: number;
  adjudicated: number;
  cacheHits: number;
  model: string;
  unavailableReason?: string | undefined;
}

export function loadConfig(projectRoot: string): LintConfig {
  for (const name of [".cclint.json", ".cclint.jsonc"]) {
    const file = join(projectRoot, name);
    if (!isFile(file)) continue;
    try {
      return JSON.parse(stripJsonComments(readFileSync(file, "utf8"))) as LintConfig;
    } catch {
      // A broken config should not stop the lint; we fall back to defaults.
      return {};
    }
  }
  return {};
}

export async function analyze(options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const discovered = discover(options);
  const config = loadConfig(discovered.projectRoot);

  // Apply excludePaths before anything reads the file lists, so an excluded
  // file is invisible to rules AND to the token budget.
  const isExcluded = makeExcluder(discovered.projectRoot, config.excludePaths);
  const discovery = {
    ...discovered,
    settings: discovered.settings.filter((s) => !isExcluded(s.file)),
    memory: discovered.memory.filter((m) => !isExcluded(m.file)),
    mcp: discovered.mcp.filter((m) => !isExcluded(m.file)),
  };

  // --- settings ------------------------------------------------------------
  const inputs: LayerInput[] = [];
  for (const entry of discovery.settings) {
    try {
      inputs.push({ file: entry.file, layer: entry.layer, text: readFileSync(entry.file, "utf8") });
    } catch {
      // Unreadable file (permissions) — skip rather than crash the run.
    }
  }
  const resolution = resolveSettings(inputs);

  // --- memory --------------------------------------------------------------
  //
  // Imported files are expanded into the corpus, not just followed for the
  // token count. Their contents are in context every turn exactly like the file
  // that imported them, so a rule living in an imported file can duplicate or
  // contradict one in CLAUDE.md — and analysing only the top-level files would
  // silently miss every such conflict.
  const memory: MemorySource[] = [];
  const seenMemory = new Set<string>();

  for (const entry of discovery.memory) {
    const chain = expandImports(entry.file, new Set());
    for (const file of chain) {
      const key = resolve(file);
      if (seenMemory.has(key)) continue;
      seenMemory.add(key);

      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const isRoot = resolve(file) === resolve(entry.file);
      const layer = isRoot ? entry.layer : "import";
      const scanned = scanMarkdown(text);
      memory.push({
        file,
        layer,
        text,
        imports: scanned.imports.map((i) => i.target),
        rules: toRules(scanned, file, layer),
      });
    }
  }

  const ctx: RuleContext = {
    discovery,
    resolution,
    memory,
    keys: resolution.keys,
    parsed: resolution.parsed,
  };

  const axes: Axis[] = [...BUILTIN_AXES, ...parseAxes(config.axes)];

  const diagnostics: Diagnostic[] = [
    ...resolution.diagnostics,
    ...settingsRules(ctx),
    ...hookRules(ctx),
    ...mcpRules(ctx),
    ...permissionRules(ctx),
    ...memoryRules(ctx, axes),
  ];

  // --- optional semantic pass ----------------------------------------------
  // Runs only when explicitly requested. The deterministic core above is
  // complete without it; this only adds findings the prefilter could not settle
  // on its own.
  let semantic: SemanticSummary | undefined;
  if (options.semantic === true) {
    const allRules = memory.flatMap((m) => m.rules);
    const pairs = buildCandidatePairs(allRules, {
      axes,
      maxPairs: options.semanticMaxPairs ?? 40,
    });
    const adjudicator = new SemanticAdjudicator({
      apiKey: options.apiKey,
      model: options.semanticModel,
      provider: options.semanticProvider,
      baseUrl: options.semanticBaseUrl,
      maxPairs: options.semanticMaxPairs,
      projectRoot: discovery.projectRoot,
    });
    diagnostics.push(...(await adjudicator.run(pairs)));
    semantic = {
      candidatePairs: pairs.length,
      adjudicated: adjudicator.adjudicated,
      cacheHits: adjudicator.cacheHits,
      unexamined: adjudicator.unexamined,
      model: adjudicator.label,
      unavailableReason: adjudicator.unavailableReason,
    };
  }

  // --- budget --------------------------------------------------------------
  // Runs BEFORE the severity filter, because it produces a finding of its own:
  // an always-loaded context large enough to be worth reporting is only knowable
  // once the tokens are counted, and it has to pass through `ignore`, severity
  // overrides and the `--strict` gate like every other rule.
  let budget: BudgetReport | undefined;
  if (options.skipBudget !== true) {
    const model = options.model ?? config.model ?? "claude-opus-5";
    const counter = new TokenCounter({
      apiKey: options.apiKey,
      model,
      offline: options.offline === true,
    });
    budget = await buildBudget(
      {
        projectRoot: discovery.projectRoot,
        memoryFiles: discovery.memory
          .filter((m) => m.layer !== "subdirectory")
          .map((m) => ({ file: m.file, label: labelFor(m.layer, m.file, discovery.projectRoot) })),
        subdirectoryMemory: discovery.memory
          .filter((m) => m.layer === "subdirectory")
          .map((m) => m.file),
        claudeDirs: discovery.claudeDirs,
        contextWindow:
          options.contextWindow ?? config.contextWindow ?? contextWindowFor(model),
      },
      counter,
    );
    counter.flush();
    diagnostics.push(...budgetDiagnostics(budget, discovery.projectRoot));
  }

  const filtered = applyConfig(diagnostics, config, options.strict === true);

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const d of filtered) counts[d.severity]++;

  return { diagnostics: filtered, budget, context: ctx, config, counts, semantic };
}

function labelFor(layer: string, file: string, root: string): string {
  if (layer === "user") return "user CLAUDE.md";
  if (file.startsWith(root)) return "project CLAUDE.md";
  return layer;
}

function applyConfig(
  diagnostics: Diagnostic[],
  config: LintConfig,
  strict: boolean,
): Diagnostic[] {
  const ignore = new Set(config.ignore ?? []);
  const out: Diagnostic[] = [];

  for (const d of diagnostics) {
    if (ignore.has(d.ruleId)) continue;

    const override = config.severity?.[d.ruleId];
    if (override === "off") continue;
    const severity = override ?? d.severity;

    // Heuristic findings are opt-in. This is the main precision lever: a
    // default run should contain only things we can prove.
    if (!strict && severity === "info" && override === undefined) continue;

    out.push({ ...d, severity });
  }

  // Group by file, then by position — the ordering every editor and CI
  // annotator expects. Sorting by severity first splits a single file across
  // multiple headings in the report, which reads as if there were two files.
  return out.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    const lineDelta = (a.position?.line ?? 0) - (b.position?.line ?? 0);
    if (lineDelta !== 0) return lineDelta;
    const rank = { error: 0, warning: 1, info: 2 } as const;
    return rank[a.severity] - rank[b.severity];
  });
}

/** Tolerate // and /* comments in the config file, same as settings.json. */
function stripJsonComments(text: string): string {
  return text
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, group) =>
      group ? "" : m,
    )
    .replace(/,(\s*[}\]])/g, "$1");
}
