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
export interface ExplainContext {
  /** Every resolvable key, so a miss can say what a hit would look like. */
  all: ResolvedKey[];
  /**
   * Files Claude Code throws away. Reported on every explain, hit or miss.
   *
   * This is the fix for a genuine wrong-answer bug, not a nicety. A
   * settings.json holding `permissions.deny` plus one trailing comma is
   * discarded wholesale, so `explain permissions.deny` truthfully found no such
   * key — and said so, in a way that reads as "you have no deny configured".
   * The user's deny is sitting in the file, not in effect, and the one command
   * that exists to explain that stayed silent, because `explain` returns before
   * diagnostics are printed. Silence about config that is NOT in effect is the
   * worst possible answer here.
   */
  discarded: { file: string; reason: string }[];
  /**
   * Set when the workspace is NOT trusted, in which case Claude Code ignores
   * project-layer `permissions.allow` entries entirely.
   *
   * Without this, `explain permissions.allow` printed the gated entries as
   * `effective:` and added "All 1 layer(s) contribute; none is overridden" —
   * while `cclint` in the same directory reported those exact entries as
   * ignored. Two commands in one tool contradicting each other, on the
   * security-relevant key, with the flagship command taking the wrong side.
   *
   * Same failure as `discarded` above: config that is in the file and not in
   * effect is the single most important thing this command can tell you.
   */
  untrustedWorkspace?: { trustKey: string; home: string };
}

/**
 * Is this contribution one Claude Code drops for want of workspace trust?
 *
 * Deliberately the same narrow boundary the permission rule enforces: only
 * `allow`, and only from a project layer. Widening it here would contradict the
 * lint output in the other direction.
 */
function isTrustGated(
  key: ResolvedKey,
  contribution: ResolvedKey["contributions"][number],
  context: ExplainContext,
): boolean {
  if (!context.untrustedWorkspace) return false;
  if (key.path !== "permissions.allow" && !key.path.startsWith("permissions.allow.")) {
    return false;
  }
  return contribution.layer === "projectShared" || contribution.layer === "projectLocal";
}

export function renderExplain(
  keys: ResolvedKey[],
  root: string,
  query: string,
  context: ExplainContext,
): string {
  if (keys.length === 0) {
    const out = [pc.yellow(`No settings key matches "${query}".`)];

    const suggestions = suggestKeys(query, context.all);
    if (suggestions.length > 0) {
      out.push("", `  ${pc.bold("Did you mean?")}`);
      for (const s of suggestions) {
        const at = s.contributions[0];
        const where = at
          ? pc.dim(`${relative(root, at.file)}${at.position ? `:${at.position.line}` : ""}`)
          : "";
        out.push(`    ${pc.cyan(s.path.padEnd(20))} ${where}`);
      }
    }

    out.push(...discardedNotice(context.discarded, root));

    // Never a bare "no". Discovery picking the wrong project root also lands
    // here, and "0 keys are available" is what makes that legible.
    out.push(
      "",
      pc.dim(
        `  ${context.all.length} key(s) are available. Run \`cclint explain\` with no key to ` +
          "list them, or `cclint doctor` to see which files were read.",
      ),
    );
    return out.join("\n");
  }

  const lines: string[] = [];
  lines.push(...discardedNotice(context.discarded, root));
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

    let gated = 0;
    for (const c of key.contributions) {
      const dead = key.shadowed.includes(c);
      const ignored = isTrustGated(key, c, context);
      if (ignored) gated++;
      const bullet = dead || ignored ? pc.red("✗") : pc.green("✓");
      const label = LAYER_LABEL[c.layer].padEnd(18);
      const suffix = dead
        ? pc.red(" (overridden — no effect)")
        : ignored
          ? pc.red(" (ignored — workspace not trusted)")
          : "";
      lines.push(`  ${bullet} ${label} ${format(c.value)}${suffix}`);
      lines.push(
        `    ${pc.dim(relative(root, c.file))}${c.position ? pc.dim(`:${c.position.line}`) : ""}`,
      );
    }

    lines.push("");
    lines.push(`  ${pc.bold("effective:")} ${format(key.effective)}`);

    /**
     * The merge is correct — these entries ARE unioned by the resolution rules.
     * Trust gating happens afterwards, so the merged value is reported as-is and
     * the caveat is stated separately rather than by quietly editing the value.
     */
    if (gated > 0 && context.untrustedWorkspace) {
      const { trustKey, home } = context.untrustedWorkspace;
      const all = gated === key.contributions.length;
      const which = all
        ? gated === 1
          ? "the project layer above"
          : "every project layer above"
        : `${gated} of the project layers above`;
      lines.push(
        pc.yellow(
          `  ! Claude Code ignores ${which}: this workspace has not been trusted,`,
        ),
        pc.yellow(
          `    so ${all ? "none of this allow list is" : "that part is not"} in effect right now.`,
        ),
        pc.dim(
          `    Fix: run Claude Code here once and accept the trust dialog, or set\n` +
            `      projects["${trustKey.replace(/\\/g, "/")}"].hasTrustDialogAccepted: true\n` +
            `      in ${home.replace(/\\/g, "/")}/.claude.json`,
        ),
      );
    }

    if (key.strategy === "hooks" || key.strategy === "concat") {
      // "none is overridden" is true of the merge and false of what runs, once a
      // layer is trust-gated. Saying it anyway is what made explain contradict
      // the lint.
      lines.push(
        pc.dim(
          gated > 0
            ? `  All ${key.contributions.length} layer(s) contribute to the merge; ` +
                `${gated} then dropped for want of trust.`
            : `  All ${key.contributions.length} layer(s) contribute; none is overridden.`,
        ),
      );
    }
  }

  return lines.join("\n");
}

/** `cclint explain` with no key — the list you cannot otherwise discover. */
export function renderExplainList(root: string, context: ExplainContext): string {
  const out: string[] = [];
  out.push(...discardedNotice(context.discarded, root));

  if (context.all.length === 0) {
    out.push(
      "",
      pc.yellow("No settings keys were resolved."),
      pc.dim("  Run `cclint doctor` to check which files were discovered."),
    );
    return out.join("\n");
  }

  out.push("", pc.bold(`${context.all.length} settings key(s) available to explain`));
  out.push(pc.dim("  <key> is matched as a prefix, so `permissions` covers all three lists."));
  out.push("");
  for (const key of context.all) {
    out.push(`  ${pc.cyan(key.path.padEnd(34))} ${pc.dim(`[${key.strategy}]`)}`);
  }
  return out.join("\n");
}

function discardedNotice(
  discarded: { file: string; reason: string }[],
  root: string,
): string[] {
  if (discarded.length === 0) return [];
  const out = [
    "",
    pc.yellow(
      `  ${discarded.length} file(s) discarded and NOT part of the resolution below:`,
    ),
  ];
  for (const d of discarded) {
    out.push(`    ${pc.red(relative(root, d.file))} ${pc.dim(`— ${d.reason}`)}`);
  }
  out.push(
    pc.dim(
      "    Keys defined only there do not appear here, and Claude Code ignores them too.",
    ),
  );
  return out;
}

/**
 * Near-misses for a key that did not match.
 *
 * Substring first, because `explain deny` returning nothing is the common trap
 * — matching is by prefix, but "deny" is the word people think in. Then edit
 * distance, which catches the typo case. That distinction matters most for
 * security keys: without it, `explain permisions.deny` and a genuinely absent
 * deny list print the same thing.
 */
export function suggestKeys(query: string, all: ResolvedKey[], limit = 5): ResolvedKey[] {
  const q = query.toLowerCase();
  const scored: { key: ResolvedKey; score: number }[] = [];

  for (const key of all) {
    const path = key.path.toLowerCase();
    const last = path.split(".").pop() ?? path;
    const qLast = q.split(".").pop() ?? q;

    let score: number | undefined;
    if (path.includes(q)) score = 0;
    else {
      const whole = editDistance(q, path);
      const tail = editDistance(qLast, last);
      const best = Math.min(whole, tail);
      // Scale tolerance with length so short keys don't match everything.
      if (best <= Math.max(1, Math.floor(Math.min(q.length, path.length) / 4))) score = best;
    }
    if (score !== undefined) scored.push({ key, score });
  }

  scored.sort((a, b) => a.score - b.score || a.key.path.localeCompare(b.key.path));
  return scored.slice(0, limit).map((s) => s.key);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

function format(value: unknown): string {
  if (typeof value === "string") return pc.cyan(JSON.stringify(value));
  const s = JSON.stringify(value);
  if (s === undefined) return pc.dim("undefined");
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}
