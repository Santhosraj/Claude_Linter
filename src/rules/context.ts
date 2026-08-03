import type { Discovery } from "../discovery/layers.js";
import type { ParsedJson } from "../parse/json.js";
import type { Diagnostic, MemorySource, ResolvedKey } from "../model/types.js";
import type { ResolutionResult } from "../resolve/settings.js";

export interface RuleContext {
  discovery: Discovery;
  resolution: ResolutionResult;
  memory: MemorySource[];
  keys: ResolvedKey[];
  parsed: Map<string, ParsedJson>;
}

export type Rule = (ctx: RuleContext) => Diagnostic[];

/**
 * Severity policy.
 *
 * Deterministic findings (a file that does not exist, a duplicate key, a schema
 * violation) are errors. Anything that depends on inference about the user's
 * environment or intent is a warning at most, and anything semantic is `info`
 * and off by default. A linter that cries wolf gets uninstalled after one run,
 * so the bar for `error` is: we can prove it from the bytes on disk.
 */
export const SEVERITY = {
  deterministic: "error",
  environmental: "warning",
  heuristic: "info",
} as const;
