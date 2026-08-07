/**
 * The effective-settings resolver.
 *
 * Given every settings layer on disk, produce — for each key — the value Claude
 * Code will actually see, plus the full provenance chain that produced it, plus
 * the list of layer values that were genuinely discarded.
 *
 * The `shadowed` list is the part that must be exactly right. For an `override`
 * key, a lower-precedence value really is dead and reporting it is a true
 * finding. For a `concat` or `hooks` key, NOTHING is discarded — every layer's
 * entries are live — and reporting them as shadowed would be a fabricated bug.
 */

import { LAYER_RANK, type Contribution, type Diagnostic, type LayerKind, type ResolvedKey, type SettingsSource } from "../model/types.js";
import { isAdditive, ruleFor } from "../model/merge-semantics.js";
import { keyPositionOf, parseJsonFile, type ParsedJson } from "../parse/json.js";

export interface LayerInput {
  file: string;
  layer: LayerKind;
  text: string;
}

export interface ResolutionResult {
  keys: ResolvedKey[];
  sources: SettingsSource[];
  diagnostics: Diagnostic[];
  /** Parsed files, retained so rules can look up positions. */
  parsed: Map<string, ParsedJson>;
}

interface LayerValue {
  layer: LayerKind;
  file: string;
  value: unknown;
}

export function resolveSettings(inputs: LayerInput[]): ResolutionResult {
  const parsed = new Map<string, ParsedJson>();
  const sources: SettingsSource[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const input of inputs) {
    const p = parseJsonFile(input.file, input.text);
    parsed.set(input.file, p);
    diagnostics.push(...p.errors);

    /**
     * A file Claude Code throws away must not participate in the merge.
     *
     * This is a second-order consequence of strict-JSON parsing and it is easy
     * to miss: a `settings.local.json` containing one comment is discarded
     * wholesale, so it cannot override anything. Leaving it in the merge made
     * cclint report the project layer as "overridden by project (local)" — a
     * shadowing relationship that does not exist, pointing at a file that is
     * not even loaded. We would have been describing a fiction in confident
     * detail.
     */
    const discarded = p.errors.some(
      (e) => e.ruleId === "json/parse-error" || e.ruleId === "json/not-strict-json",
    );

    sources.push({
      file: input.file,
      layer: input.layer,
      value: discarded || !isPlainObject(p.value) ? undefined : p.value,
      text: input.text,
      parseErrors: p.errors,
    });
  }

  // Lowest precedence first, so `shadowed` reads bottom-up like a stack trace.
  const ordered = sources
    .filter((s) => s.value !== undefined)
    .sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer]);

  const rootValues: LayerValue[] = ordered.map((s) => ({
    layer: s.layer,
    file: s.file,
    value: s.value,
  }));

  const keys: ResolvedKey[] = [];
  resolveNode("", rootValues, keys, parsed);

  keys.sort((a, b) => a.path.localeCompare(b.path));
  return { keys, sources, diagnostics, parsed };
}

/**
 * Recursive descent. `path === ""` is the synthetic root object, which is
 * always treated as a deep merge (top-level keys are independent of each other).
 */
function resolveNode(
  path: string,
  values: LayerValue[],
  out: ResolvedKey[],
  parsed: Map<string, ParsedJson>,
): void {
  if (values.length === 0) return;

  const isRoot = path === "";
  const rule = isRoot ? { strategy: "deepMerge" as const } : ruleFor(path);

  // ---- hooks: recurse one level into events, then concat per event --------
  if (rule.strategy === "hooks") {
    for (const child of childKeys(values)) {
      const childPath = `${path}.${child}`;
      const childValues = pluck(values, child);
      out.push(makeConcat(childPath, "hooks", childValues, parsed));
    }
    return;
  }

  // ---- deep merge: descend key-by-key ------------------------------------
  if (rule.strategy === "deepMerge") {
    const objectValues = values.filter((v) => isPlainObject(v.value));
    // If a layer supplies a non-object where we expected an object, we cannot
    // merge it; fall back to override so we never silently drop it.
    if (objectValues.length !== values.length && !isRoot) {
      out.push(makeOverride(path, values, parsed));
      return;
    }
    for (const child of childKeys(objectValues)) {
      const childPath = isRoot ? child : `${path}.${child}`;
      resolveNode(childPath, pluck(objectValues, child), out, parsed);
    }
    return;
  }

  // ---- concat -------------------------------------------------------------
  if (rule.strategy === "concat") {
    out.push(makeConcat(path, "concat", values, parsed));
    return;
  }

  // ---- override -----------------------------------------------------------
  out.push(makeOverride(path, values, parsed));
}

function makeOverride(
  path: string,
  values: LayerValue[],
  parsed: Map<string, ParsedJson>,
): ResolvedKey {
  const contributions = values.map((v) => toContribution(path, v, parsed));
  // Highest rank wins. `values` is sorted ascending, so the last one is it.
  const winner = contributions.at(-1);
  return {
    path,
    strategy: "override",
    effective: winner?.value,
    contributions,
    shadowed: contributions.slice(0, -1),
  };
}

function makeConcat(
  path: string,
  strategy: "concat" | "hooks",
  values: LayerValue[],
  parsed: Map<string, ParsedJson>,
): ResolvedKey {
  const contributions = values.map((v) => toContribution(path, v, parsed));
  const merged: unknown[] = [];
  for (const c of contributions) {
    if (Array.isArray(c.value)) merged.push(...c.value);
    else if (c.value !== undefined) merged.push(c.value);
  }
  return {
    path,
    strategy,
    effective: merged,
    contributions,
    // Additive strategies discard nothing. This empty array is load-bearing.
    shadowed: [],
  };
}

function toContribution(
  path: string,
  v: LayerValue,
  parsed: Map<string, ParsedJson>,
): Contribution {
  const p = parsed.get(v.file);
  const position = p ? keyPositionOf(p, path) : undefined;
  return { layer: v.layer, file: v.file, value: v.value, position };
}

/** Union of child keys across layers, preserving first-seen order. */
function childKeys(values: LayerValue[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const v of values) {
    if (!isPlainObject(v.value)) continue;
    for (const k of Object.keys(v.value)) {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
  }
  return order;
}

function pluck(values: LayerValue[], key: string): LayerValue[] {
  const out: LayerValue[] = [];
  for (const v of values) {
    if (!isPlainObject(v.value)) continue;
    if (!(key in v.value)) continue;
    out.push({ layer: v.layer, file: v.file, value: v.value[key] });
  }
  return out;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Filter for `cclint explain <path>` — prefix match, case-insensitive. */
export function selectKeys(keys: ResolvedKey[], query: string): ResolvedKey[] {
  const q = query.toLowerCase();
  return keys.filter((k) => k.path.toLowerCase().startsWith(q));
}

/** Keys where a lower layer's value is genuinely dead. */
export function shadowedKeys(keys: ResolvedKey[]): ResolvedKey[] {
  return keys.filter((k) => !isAdditive(k.strategy) && k.shadowed.length > 0);
}
