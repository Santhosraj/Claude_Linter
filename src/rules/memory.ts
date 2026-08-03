/**
 * CLAUDE.md checks.
 *
 * Reminder on the composition model: memory files CONCATENATE. Every level is
 * in context at once. So a project rule that restates a user rule is not an
 * "override" — it is duplicated instruction burning tokens twice, and two
 * levels stating opposite things is a live conflict with nothing to resolve it.
 * Wording the findings that way is the difference between correct and plausible.
 */

import { dirname, isAbsolute, resolve } from "node:path";

import { isFile, relative } from "../discovery/layers.js";
import { scanMarkdown } from "../parse/markdown.js";
import { BUILTIN_AXES, classify, type Axis } from "./axes.js";
import { SEVERITY, type RuleContext } from "./context.js";
import type { Diagnostic, MemoryRule } from "../model/types.js";

export function memoryRules(ctx: RuleContext, axes: Axis[] = BUILTIN_AXES): Diagnostic[] {
  const out: Diagnostic[] = [];
  const root = ctx.discovery.projectRoot;

  // --- dead @imports -------------------------------------------------------
  for (const source of ctx.memory) {
    const scanned = scanMarkdown(source.text);
    for (const imp of scanned.imports) {
      const target = isAbsolute(imp.target)
        ? imp.target
        : resolve(dirname(source.file), imp.target);
      if (!isFile(target)) {
        out.push({
          ruleId: "memory/dead-import",
          severity: SEVERITY.deterministic,
          message: `Imported file does not exist: @${imp.target}`,
          file: source.file,
          position: imp.position,
          detail: [`Resolved to: ${relative(root, target)}`],
          data: { target },
        });
      }
    }
  }

  // --- import cycles -------------------------------------------------------
  out.push(...detectImportCycles(ctx));

  // --- duplicate rules -----------------------------------------------------
  const byNormalized = new Map<string, MemoryRule[]>();
  for (const source of ctx.memory) {
    for (const rule of source.rules) {
      if (rule.normalized.length < 12) continue; // too short to be meaningful
      const list = byNormalized.get(rule.normalized) ?? [];
      list.push(rule);
      byNormalized.set(rule.normalized, list);
    }
  }

  for (const [, group] of byNormalized) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    if (!first) continue;

    const sameFile = rest.every((r) => r.file === first.file);
    for (const dup of rest) {
      out.push({
        ruleId: sameFile ? "memory/duplicate-rule" : "memory/redundant-across-layers",
        severity: SEVERITY.environmental,
        message: sameFile
          ? "This rule is stated twice in the same file."
          : "This rule is already stated in another CLAUDE.md that is also always in context.",
        file: dup.file,
        position: dup.position,
        detail: [
          `First stated at ${relative(root, first.file)}:${first.position.line}`,
          "Both copies are loaded every turn — the repetition costs tokens without adding instruction.",
        ],
        data: { text: dup.text, firstFile: first.file, firstLine: first.position.line },
      });
    }
  }

  // --- axis conflicts (heuristic, info-tier) -------------------------------
  out.push(...axisConflicts(ctx, axes));

  return out;
}

function detectImportCycles(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const graph = new Map<string, { target: string; line: number }[]>();

  for (const source of ctx.memory) {
    const edges: { target: string; line: number }[] = [];
    for (const imp of scanMarkdown(source.text).imports) {
      const target = isAbsolute(imp.target)
        ? resolve(imp.target)
        : resolve(dirname(source.file), imp.target);
      if (isFile(target)) edges.push({ target, line: imp.position.line });
    }
    graph.set(resolve(source.file), edges);
  }

  const state = new Map<string, "visiting" | "done">();
  const reported = new Set<string>();

  const visit = (file: string, stack: string[]): void => {
    if (state.get(file) === "done") return;
    if (state.get(file) === "visiting") {
      const start = stack.indexOf(file);
      const cycle = [...stack.slice(start), file];
      const key = [...cycle].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        out.push({
          ruleId: "memory/import-cycle",
          severity: SEVERITY.deterministic,
          message: "Circular @import chain.",
          file,
          detail: cycle.map((f) => relative(ctx.discovery.projectRoot, f)),
          data: { cycle },
        });
      }
      return;
    }
    state.set(file, "visiting");
    for (const edge of graph.get(file) ?? []) visit(edge.target, [...stack, file]);
    state.set(file, "done");
  };

  for (const file of graph.keys()) visit(file, []);
  return out;
}

/**
 * Flag two rules that pick opposite sides of a known binary decision.
 *
 * Precision guard: we only report when the two rules come from different
 * sources or different sections. Two adjacent bullets under the same heading
 * discussing tabs and spaces are almost always one coherent instruction
 * ("use tabs, never spaces"), not a conflict.
 */
function axisConflicts(ctx: RuleContext, axes: Axis[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const byAxis = new Map<string, { rule: MemoryRule; side: string; label: string }[]>();

  for (const source of ctx.memory) {
    for (const rule of source.rules) {
      for (const match of classify(rule.text, axes)) {
        const list = byAxis.get(match.axis.id) ?? [];
        list.push({ rule, side: match.side.name, label: match.axis.label });
        byAxis.set(match.axis.id, list);
      }
    }
  }

  // A rule duplicated across three files would otherwise produce the same
  // conflict three times over. Users read that as three problems.
  const reportedPairs = new Set<string>();

  for (const [axisId, entries] of byAxis) {
    const sides = new Set(entries.map((e) => e.side));
    if (sides.size < 2) continue;

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]!;
        const b = entries[j]!;
        if (a.side === b.side) continue;

        // Identical text is a duplicate, not a conflict — already reported above.
        if (a.rule.normalized === b.rule.normalized) continue;

        const sameSection =
          a.rule.file === b.rule.file &&
          a.rule.headings.join("/") === b.rule.headings.join("/");
        if (sameSection) continue;

        const pairKey = [axisId, a.rule.normalized, b.rule.normalized].sort().join("|");
        if (reportedPairs.has(pairKey)) continue;
        reportedPairs.add(pairKey);

        out.push({
          ruleId: "memory/axis-conflict",
          severity: SEVERITY.heuristic,
          heuristic: true,
          message: `Possible conflict on ${a.label}: "${a.side}" vs "${b.side}".`,
          file: b.rule.file,
          position: b.rule.position,
          detail: [
            `${relative(ctx.discovery.projectRoot, a.rule.file)}:${a.rule.position.line} — ${a.rule.text}`,
            `${relative(ctx.discovery.projectRoot, b.rule.file)}:${b.rule.position.line} — ${b.rule.text}`,
            "Both files are in context simultaneously; neither overrides the other.",
          ],
          data: { axis: axisId, sides: [a.side, b.side] },
        });
      }
    }
  }

  return out;
}
