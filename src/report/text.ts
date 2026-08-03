import pc from "picocolors";

import { relative } from "../discovery/layers.js";
import { LAYER_LABEL, type Diagnostic, type ResolvedKey, type Severity } from "../model/types.js";
import { ruleFor } from "../model/merge-semantics.js";
import type { BudgetReport } from "../tokens/budget.js";

const MARK: Record<Severity, string> = {
  error: pc.red("error"),
  warning: pc.yellow("warn "),
  info: pc.blue("info "),
};

export function renderDiagnostics(
  diagnostics: Diagnostic[],
  root: string,
  counts: Record<Severity, number>,
): string {
  const lines: string[] = [];

  if (diagnostics.length === 0) {
    lines.push(pc.green("✓ No issues found."));
    return lines.join("\n");
  }

  let currentFile = "";
  for (const d of diagnostics) {
    const file = relative(root, d.file);
    if (file !== currentFile) {
      currentFile = file;
      lines.push("");
      lines.push(pc.underline(file));
    }

    const loc = d.position ? pc.dim(`${d.position.line}:${d.position.column}`) : pc.dim("-");
    lines.push(`  ${loc.padEnd(18)} ${MARK[d.severity]}  ${d.message}  ${pc.dim(d.ruleId)}`);
    for (const detail of d.detail ?? []) {
      lines.push(`  ${" ".repeat(9)} ${pc.dim("│")} ${pc.dim(detail)}`);
    }
  }

  lines.push("");
  const parts: string[] = [];
  if (counts.error) parts.push(pc.red(`${counts.error} error${counts.error === 1 ? "" : "s"}`));
  if (counts.warning) parts.push(pc.yellow(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`));
  if (counts.info) parts.push(pc.blue(`${counts.info} info`));
  lines.push(parts.join(", ") || pc.green("clean"));

  return lines.join("\n");
}

export function renderBudget(budget: BudgetReport, root: string): string {
  const lines: string[] = [];
  const pct = (n: number) => ((n / budget.contextWindow) * 100).toFixed(2);
  const estimated = budget.entries.some((e) => e.mode === "estimated");
  const tilde = estimated ? "~" : "";

  lines.push(pc.bold("Context budget"));
  lines.push("");

  const always = budget.entries.filter((e) => e.loadClass === "always");
  const meta = budget.entries.filter((e) => e.loadClass === "metadataOnly");
  const onDemand = budget.entries.filter((e) => e.loadClass === "onDemand");

  const section = (title: string, entries: typeof budget.entries, note: string) => {
    if (entries.length === 0) return;
    lines.push(pc.bold(title));
    lines.push(pc.dim(`  ${note}`));
    for (const e of entries.sort((a, b) => b.tokens - a.tokens)) {
      const t = `${e.mode === "estimated" ? "~" : ""}${e.tokens.toLocaleString()}`;
      const extra =
        e.fullTokens !== undefined && e.fullTokens > e.tokens
          ? pc.dim(`  (body ${e.fullTokens.toLocaleString()} more, loaded on use)`)
          : "";
      lines.push(`  ${t.padStart(9)}  ${e.label}${extra}`);
      lines.push(`  ${" ".repeat(9)}  ${pc.dim(relative(root, e.file))}`);
    }
    lines.push("");
  };

  section("Always in context", always, "loaded on every turn");
  section("Advertised only", meta, "name + description in context; body loads on use");
  section("On demand", onDemand, "costs nothing until invoked");

  lines.push(pc.bold("Per-turn floor"));
  lines.push(
    `  ${tilde}${budget.perTurnTotal.toLocaleString()} tokens ` +
      pc.dim(`(${pct(budget.perTurnTotal)}% of a ${budget.contextWindow.toLocaleString()}-token window)`),
  );
  lines.push(
    pc.dim(
      `  = ${tilde}${budget.alwaysLoaded.toLocaleString()} always-loaded + ` +
        `${tilde}${budget.metadataOnly.toLocaleString()} advertised`,
    ),
  );
  lines.push(
    pc.dim(
      `  ${tilde}${budget.onDemand.toLocaleString()} more is reachable on demand and is NOT counted above.`,
    ),
  );

  if (budget.degradedReason) {
    lines.push("");
    lines.push(pc.yellow(`  ! ${budget.degradedReason}`));
    lines.push(pc.dim("    Set ANTHROPIC_API_KEY for exact counts via the token-counting endpoint."));
  }

  return lines.join("\n");
}

/**
 * `cclint explain <path>` — the effective-config view.
 * This is the flagship output: which layer won, which layers also contributed,
 * and which (if any) were genuinely discarded.
 */
export function renderExplain(keys: ResolvedKey[], root: string, query: string): string {
  if (keys.length === 0) {
    return pc.yellow(`No settings key matches "${query}".`);
  }

  const lines: string[] = [];
  for (const key of keys) {
    const rule = ruleFor(key.path);
    lines.push("");
    lines.push(`${pc.bold(key.path)}  ${pc.dim(`[${key.strategy}]`)}`);
    lines.push(pc.dim(`  ${rule.note}`));
    // Surface provenance at the point of use. A user reading "both hooks fire"
    // deserves to know whether that is proven behaviour or our reading of the
    // docs — it is the difference between acting on this and double-checking it.
    if (rule.confidence === "conformance") {
      lines.push(
        pc.green(`  ✓ verified against the real Claude Code binary`) +
          pc.dim(` (${(rule.provenance ?? []).length} conformance fixture(s))`),
      );
    } else {
      lines.push(
        pc.dim(
          `  merge rule confidence: ${rule.confidence}` +
            (rule.confidence === "assumed"
              ? " — not yet pinned by a conformance fixture"
              : " — from documentation, not yet pinned by a fixture"),
        ),
      );
    }
    lines.push("");

    for (const c of key.contributions) {
      const dead = key.shadowed.includes(c);
      const bullet = dead ? pc.red("✗") : pc.green("✓");
      const label = LAYER_LABEL[c.layer].padEnd(18);
      const suffix = dead ? pc.red(" (overridden — no effect)") : "";
      lines.push(`  ${bullet} ${label} ${format(c.value)}${suffix}`);
      lines.push(
        `    ${pc.dim(relative(root, c.file))}${c.position ? pc.dim(`:${c.position.line}`) : ""}`,
      );
    }

    lines.push("");
    lines.push(`  ${pc.bold("effective:")} ${format(key.effective)}`);

    if (key.strategy === "hooks" || key.strategy === "concat") {
      lines.push(
        pc.dim(
          `  All ${key.contributions.length} layer(s) contribute; none is overridden.`,
        ),
      );
    }
  }

  return lines.join("\n");
}

function format(value: unknown): string {
  if (typeof value === "string") return pc.cyan(JSON.stringify(value));
  const s = JSON.stringify(value);
  if (s === undefined) return pc.dim("undefined");
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}
