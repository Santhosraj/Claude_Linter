/**
 * Settings-layer checks driven by the resolver.
 *
 * The headline rule here is `settings/shadowed-key`: a value written in one
 * layer that a higher-precedence layer overrides, so it is dead config the
 * author almost certainly believes is live.
 *
 * The correctness constraint: this rule MUST only fire for `override` keys.
 * The resolver already guarantees `shadowed` is empty for additive strategies,
 * but we assert it here too, because a regression that makes this rule fire on
 * hooks would be the single most damaging bug the tool could ship — it would
 * tell users to delete hooks that are actually running.
 */

import { isAdditive, MERGE_RULES, ruleFor } from "../model/merge-semantics.js";
import { suggestSettingsKey } from "../model/known-settings.js";
import { LAYER_LABEL } from "../model/types.js";
import { relative } from "../discovery/layers.js";
import { SEVERITY, type RuleContext } from "./context.js";
import type { Diagnostic } from "../model/types.js";

export function settingsRules(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const root = ctx.discovery.projectRoot;

  for (const key of ctx.keys) {
    const rule = ruleFor(key.path);

    if (isAdditive(key.strategy)) {
      // Invariant guard — see the module comment.
      if (key.shadowed.length > 0) {
        throw new Error(
          `internal invariant violated: additive key "${key.path}" reported ` +
            `${key.shadowed.length} shadowed contributions`,
        );
      }
      continue;
    }

    for (const dead of key.shadowed) {
      // If our merge rule for this key is only assumed, we might be wrong about
      // it being an override key at all — so we demote the finding rather than
      // asserting dead config with confidence we do not have.
      const assumed = rule.confidence === "assumed";
      const winner = key.contributions.at(-1);

      out.push({
        ruleId: "settings/shadowed-key",
        severity: assumed ? SEVERITY.heuristic : SEVERITY.environmental,
        heuristic: assumed,
        message:
          `\`${key.path}\` set here is overridden by ` +
          `${LAYER_LABEL[winner?.layer ?? "projectLocal"]} and has no effect.`,
        file: dead.file,
        position: dead.position,
        detail: [
          `this layer (${LAYER_LABEL[dead.layer]}): ${preview(dead.value)}`,
          `effective (${LAYER_LABEL[winner?.layer ?? "projectLocal"]}): ${preview(key.effective)}` +
            (winner ? `  ← ${relative(root, winner.file)}` : ""),
          assumed
            ? `Merge rule for "${key.path}" is unverified (${rule.confidence}); ` +
              "if this key actually accumulates, this finding is wrong."
            : rule.note,
        ],
        data: { path: key.path, deadLayer: dead.layer, winningLayer: winner?.layer },
      });
    }
  }

  // Misspelt keys: worth surfacing, because Claude Code ignores an unknown key
  // without a word, so a typo looks identical to a setting that did not work.
  //
  // This used to report every key absent from the merge-semantics table, which
  // covers 32 rules — so real keys like `autoMemoryEnabled` and `modelSettings`
  // were "unrecognised". It now reports only a key that is a near-miss of a known
  // one, and names the key it was probably meant to be. A key far from every
  // known one is left alone: it is far more often real-but-unlisted than a typo.
  const modelled = MERGE_RULES.map((r) => r.path).filter((p) => p !== "*" && !p.includes("."));
  for (const key of ctx.keys) {
    if (key.path.includes(".")) continue; // only check top-level
    if (ruleFor(key.path).path !== "*") continue;
    const suggestion = suggestSettingsKey(key.path, modelled);
    if (suggestion === undefined) continue;
    const first = key.contributions[0];
    if (!first) continue;

    out.push({
      ruleId: "settings/unknown-key",
      severity: SEVERITY.heuristic,
      heuristic: true,
      message: `Unrecognised settings key \`${key.path}\` — did you mean \`${suggestion}\`?`,
      file: first.file,
      position: first.position,
      detail: [
        "Claude Code ignores unknown keys without warning, so this setting is not applied.",
        `\`${suggestion}\` is a known key ${
          suggestion.toLowerCase() === key.path.toLowerCase()
            ? "differing only in case — JSON keys are case-sensitive"
            : "a character or two away"
        }.`,
      ],
      data: { path: key.path, suggestion },
    });
  }

  return out;
}

function preview(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return "undefined";
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
