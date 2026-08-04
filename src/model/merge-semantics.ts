/**
 * THE MERGE SEMANTICS TABLE
 * =========================
 *
 * This is the most load-bearing artifact in the tool. Every resolver decision,
 * every "your rule is dead" finding, and every explain output reads from here.
 *
 * The critical insight it encodes: **settings.json keys do not all merge the
 * same way.** Modelling settings as "higher layer wins" uniformly is wrong and
 * produces confidently-incorrect output — it will report that a user-level hook
 * was overridden by a project hook when in reality BOTH run.
 *
 * Every entry carries a `confidence`:
 *   - `conformance` — proven against the real Claude Code binary by a fixture
 *                     in test/fixtures/conformance. Trustworthy.
 *   - `documented`  — stated in official docs but not yet pinned by a fixture.
 *   - `assumed`     — our best model. May be wrong. Findings that depend on an
 *                     `assumed` entry are automatically demoted in severity.
 *
 * The goal is to drive every row to `conformance`. `npm run conformance:record`
 * regenerates fixtures against the installed binary; CI re-runs them on each
 * Claude Code release so we learn when our model goes stale instead of silently
 * lying to users.
 */

import type { Confidence, MergeStrategy } from "./types.js";

export interface MergeRule {
  /**
   * Dotted path. A trailing `.*` matches any child (e.g. `env.*`).
   * More specific paths win over less specific ones.
   */
  path: string;
  strategy: MergeStrategy;
  confidence: Confidence;
  /** Shown in `explain` output to justify the resolution to the user. */
  note: string;
  /**
   * Fixture directories under test/fixtures/ that prove this rule against the
   * real binary. REQUIRED for `confidence: "conformance"` — a meta-test asserts
   * the fixtures actually exist and carry recordings, so a rule cannot be
   * promoted just by editing the label.
   */
  provenance?: string[];
}

export const MERGE_RULES: MergeRule[] = [
  // ---------------------------------------------------------------------------
  // Hooks — the whole reason this tool exists.
  // ---------------------------------------------------------------------------
  {
    path: "hooks",
    strategy: "hooks",
    confidence: "conformance",
    note:
      "Hooks from every layer are additive: a project hook does not replace a " +
      "user hook for the same event — both fire. Plugins can also contribute hooks.",
    // Proven against the real binary: each fixture registers a UserPromptSubmit
    // hook in a different layer, and the recording captures which layers'
    // hooks actually executed. Three layers accumulate in precedence order.
    provenance: [
      "hooks-additive-across-layers",
      "hooks-local-layer",
      "hooks-three-layer-accumulation",
    ],
  },

  // ---------------------------------------------------------------------------
  // Permissions — lists accumulate, mode is a scalar.
  //
  // The container entry is required: without it `permissions` falls through to
  // DEFAULT_RULE (override) and the resolver never descends, so allow/deny get
  // silently replaced wholesale instead of unioned. Any object key whose
  // children have their own rules needs a container entry like this one.
  // ---------------------------------------------------------------------------
  {
    path: "permissions",
    strategy: "deepMerge",
    confidence: "documented",
    note: "Container: each permissions sub-key merges by its own rule.",
  },
  {
    path: "permissions.allow",
    strategy: "concat",
    confidence: "documented",
    note: "Allow entries from all layers are unioned; none are discarded.",
  },
  {
    path: "permissions.deny",
    strategy: "concat",
    confidence: "documented",
    note: "Deny entries from all layers are unioned. A deny in any layer is live.",
  },
  {
    path: "permissions.ask",
    strategy: "concat",
    confidence: "documented",
    note: "Ask entries from all layers are unioned.",
  },
  {
    path: "permissions.additionalDirectories",
    strategy: "concat",
    confidence: "assumed",
    note: "Directory grants accumulate across layers.",
  },
  {
    path: "permissions.defaultMode",
    strategy: "override",
    confidence: "documented",
    note: "Scalar mode; the highest-precedence layer that sets it wins.",
  },
  {
    path: "permissions.disableBypassPermissionsMode",
    strategy: "override",
    confidence: "assumed",
    note: "Scalar policy switch, typically set by enterprise policy.",
  },

  // ---------------------------------------------------------------------------
  // Environment + plugins — object merges, key-by-key.
  // ---------------------------------------------------------------------------
  {
    path: "env",
    strategy: "deepMerge",
    confidence: "documented",
    note:
      "Env vars merge per-key: a project layer setting FOO does not clear a " +
      "user layer's BAR. Only same-key collisions resolve by precedence.",
  },
  {
    path: "enabledPlugins",
    strategy: "deepMerge",
    confidence: "assumed",
    note: "Plugin enablement merges per plugin id.",
  },
  {
    path: "sandbox",
    strategy: "deepMerge",
    confidence: "assumed",
    note: "Sandbox config merges per sub-key.",
  },

  // ---------------------------------------------------------------------------
  // Plain scalars — highest precedence wins, lower layers are genuinely dead.
  // ---------------------------------------------------------------------------
  { path: "model", strategy: "override", confidence: "documented", note: "Scalar." },
  { path: "theme", strategy: "override", confidence: "documented", note: "Scalar." },
  { path: "effortLevel", strategy: "override", confidence: "assumed", note: "Scalar." },
  { path: "outputStyle", strategy: "override", confidence: "documented", note: "Scalar." },
  { path: "statusLine", strategy: "override", confidence: "documented", note: "Replaced wholesale, not merged." },
  { path: "apiKeyHelper", strategy: "override", confidence: "documented", note: "Scalar command path." },
  { path: "awsAuthRefresh", strategy: "override", confidence: "assumed", note: "Scalar command." },
  { path: "awsCredentialExport", strategy: "override", confidence: "assumed", note: "Scalar command." },
  { path: "otelHeadersHelper", strategy: "override", confidence: "assumed", note: "Scalar command." },
  { path: "forceLoginMethod", strategy: "override", confidence: "assumed", note: "Scalar." },
  { path: "cleanupPeriodDays", strategy: "override", confidence: "documented", note: "Scalar." },
  { path: "includeCoAuthoredBy", strategy: "override", confidence: "documented", note: "Scalar." },
  { path: "disableAllHooks", strategy: "override", confidence: "assumed", note: "Scalar kill-switch." },
  { path: "autoUpdates", strategy: "override", confidence: "assumed", note: "Scalar." },
  { path: "autoUpdatesChannel", strategy: "override", confidence: "assumed", note: "Scalar." },
  { path: "spinnerTipsEnabled", strategy: "override", confidence: "assumed", note: "Scalar." },
  { path: "agent", strategy: "override", confidence: "assumed", note: "Scalar default agent name." },

  // Observed in real user settings while dogfooding. Adding them is not
  // cosmetic: an unlisted key is reported as possibly-a-typo, so every genuine
  // setting we omit is noise charged against the tool's credibility.
  { path: "switchModelsOnFlag", strategy: "override", confidence: "assumed", note: "Scalar." },
  { path: "agentPushNotifEnabled", strategy: "override", confidence: "assumed", note: "Scalar." },
  { path: "inputNeededNotifEnabled", strategy: "override", confidence: "assumed", note: "Scalar." },
  { path: "alwaysThinkingEnabled", strategy: "override", confidence: "assumed", note: "Scalar." },
];

/** Fallback when a key is not in the table at all. */
export const DEFAULT_RULE: MergeRule = {
  path: "*",
  strategy: "override",
  confidence: "assumed",
  note:
    "Unknown key — not present in the merge-semantics table. Assuming scalar " +
    "override. If this key actually accumulates across layers, findings about " +
    "it may be wrong; please open an issue so we can add a conformance fixture.",
};

/**
 * Resolve the merge rule for a dotted path. Most-specific match wins, so
 * `permissions.allow` beats a hypothetical `permissions` entry.
 */
export function ruleFor(path: string): MergeRule {
  let best: MergeRule | undefined;
  let bestScore = -1;

  for (const rule of MERGE_RULES) {
    const score = matchScore(rule.path, path);
    if (score > bestScore) {
      bestScore = score;
      best = rule;
    }
  }
  return best ?? DEFAULT_RULE;
}

/**
 * Score how well `pattern` matches `path`. Returns -1 for no match, otherwise
 * the number of matched segments (higher = more specific).
 */
function matchScore(pattern: string, path: string): number {
  if (pattern === path) return pattern.split(".").length * 10;

  const pSegs = pattern.split(".");
  const tSegs = path.split(".");

  // A pattern matches if it is a prefix of the path (so `hooks` covers
  // `hooks.PreToolUse`) or if it uses an explicit `*` tail.
  if (pSegs.length > tSegs.length) return -1;

  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i];
    if (p === "*") continue;
    if (p !== tSegs[i]) return -1;
  }
  return pSegs.length;
}

/** True when the strategy means lower layers stay live (nothing is discarded). */
export function isAdditive(strategy: MergeStrategy): boolean {
  return strategy === "concat" || strategy === "hooks";
}

/** Coverage stat surfaced by `cclint doctor`, to keep us honest. */
export function confidenceBreakdown(): Record<Confidence, number> {
  const out: Record<Confidence, number> = { conformance: 0, documented: 0, assumed: 0 };
  for (const r of MERGE_RULES) out[r.confidence]++;
  return out;
}
