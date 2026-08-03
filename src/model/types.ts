/**
 * Core domain types.
 *
 * Two composition models coexist in a Claude Code project and MUST NOT be
 * conflated — this is the single most important correctness constraint in the
 * whole tool:
 *
 *   - MEMORY (CLAUDE.md): every applicable level is loaded into context
 *     simultaneously and CONCATENATED. Nothing "overrides" anything. Two levels
 *     stating opposite rules is a live, unresolved conflict.
 *
 *   - SETTINGS (settings.json): layers are MERGED with precedence, and the
 *     merge rule differs per key. Some keys override, some concatenate (all
 *     values are active), some deep-merge. See merge-semantics.ts.
 */

/** Where a piece of config came from. Ordered lowest → highest precedence. */
export type LayerKind =
  | "user" //            ~/.claude/settings.json
  | "projectShared" //   <project>/.claude/settings.json      (checked in)
  | "projectLocal" //    <project>/.claude/settings.local.json (gitignored)
  | "cliFlag" //         --settings / inline flags
  | "managedPolicy"; //  enterprise managed-settings.json (highest — it is policy)

/**
 * Precedence rank. Higher wins for `override` keys.
 *
 * Enterprise managed policy deliberately sits ABOVE cli flags: it exists to be
 * unbypassable. This ordering is asserted by the conformance corpus rather than
 * assumed — see test/conformance.
 */
export const LAYER_RANK: Record<LayerKind, number> = {
  user: 10,
  projectShared: 20,
  projectLocal: 30,
  cliFlag: 40,
  managedPolicy: 50,
};

export const LAYER_LABEL: Record<LayerKind, string> = {
  user: "user",
  projectShared: "project",
  projectLocal: "project (local)",
  cliFlag: "cli",
  managedPolicy: "enterprise policy",
};

/** A 1-indexed source position, exact enough to hyperlink and to annotate in CI. */
export interface Position {
  line: number;
  column: number;
  /** Byte offset into the file, when available. */
  offset?: number;
  endLine?: number;
  endColumn?: number;
}

export interface SourceRef {
  file: string;
  layer: LayerKind;
  position?: Position;
}

/** A settings file we found on disk, parsed with positions preserved. */
export interface SettingsSource {
  file: string;
  layer: LayerKind;
  /** Parsed value. `undefined` when the file failed to parse. */
  value: Record<string, unknown> | undefined;
  /** Raw text, retained so we can map offsets → line/col lazily. */
  text: string;
  parseErrors: Diagnostic[];
}

/**
 * One resolved settings key, carrying every layer that contributed to it.
 * This is what `cclint explain` prints, and it is the reason the tool
 * exists: nobody can hold the cross-layer merge in their head.
 */
export interface ResolvedKey {
  /** Dotted path, e.g. `permissions.allow` or `hooks.PreToolUse`. */
  path: string;
  strategy: MergeStrategy;
  /** Final value after applying the strategy across all layers. */
  effective: unknown;
  contributions: Contribution[];
  /**
   * Layers whose value was discarded because a higher-precedence layer
   * overrode it. Empty for `concat` / `deepMerge` keys — nothing is discarded
   * there, which is exactly the distinction naive linters get wrong.
   */
  shadowed: Contribution[];
}

export interface Contribution {
  layer: LayerKind;
  file: string;
  value: unknown;
  position?: Position;
}

export type MergeStrategy =
  /** Highest-precedence layer wins outright; lower layers are dead. */
  | "override"
  /** Arrays from every layer are concatenated — all entries are live. */
  | "concat"
  /** Objects merged key-by-key; per-key conflicts resolve by precedence. */
  | "deepMerge"
  /**
   * Hooks: grouped by event, then by matcher. Every layer's hooks for a given
   * event ALL RUN. Higher precedence does not silence lower precedence.
   */
  | "hooks";

/**
 * How confident we are that a merge rule matches real Claude Code behavior.
 * Rules are demoted to `assumed` until the conformance corpus proves them.
 */
export type Confidence = "conformance" | "documented" | "assumed";

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  ruleId: string;
  severity: Severity;
  message: string;
  file: string;
  position?: Position;
  /** Extra lines rendered under the message. */
  detail?: string[];
  /** Machine-readable payload for --format=json consumers. */
  data?: Record<string, unknown>;
  /** Only heuristic rules set this; deterministic rules leave it undefined. */
  heuristic?: boolean;
}

/** A single directive extracted from a CLAUDE.md file. */
export interface MemoryRule {
  /** Raw text of the rule as written. */
  text: string;
  /** Normalized, lowercased, punctuation-stripped — used for dedupe. */
  normalized: string;
  file: string;
  layer: MemoryLayer;
  position: Position;
  /** Heading path the rule sits under, e.g. ["Code style", "Formatting"]. */
  headings: string[];
}

/**
 * CLAUDE.md layers. Note these do NOT have precedence in the settings sense —
 * they are all concatenated into context together.
 */
export type MemoryLayer = "enterprise" | "user" | "project" | "subdirectory" | "import";

export interface MemorySource {
  file: string;
  layer: MemoryLayer;
  text: string;
  /** Files pulled in via `@path` imports, resolved transitively. */
  imports: string[];
  rules: MemoryRule[];
}
