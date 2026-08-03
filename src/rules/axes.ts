/**
 * The conflict-axis library.
 *
 * Honest framing: this is NOT semantic contradiction detection. Pure heuristics
 * cannot tell you that "prefer functional composition" contradicts "model all
 * domain concepts as classes". What this CAN do reliably is catch the small set
 * of well-known binary decisions that teams actually flip-flop on across config
 * layers, where both sides are lexically recognisable.
 *
 * Everything here produces `info`-severity findings, off by default. The
 * general case is handled by the opt-in `--semantic` adjudication pass, which
 * uses this same prefilter to pick candidate pairs so the model only ever sees
 * a handful of short rules.
 *
 * Users extend this via `axes` in .cclint.json rather than patching source.
 */

export interface AxisSide {
  name: string;
  patterns: RegExp[];
}

export interface Axis {
  id: string;
  label: string;
  sides: AxisSide[];
}

export const BUILTIN_AXES: Axis[] = [
  {
    id: "indentation",
    label: "indentation style",
    sides: [
      { name: "tabs", patterns: [/\btabs?\b(?!.*\bnot\b)/i] },
      { name: "spaces", patterns: [/\bspaces\b/i, /\b[24][- ]space/i] },
    ],
  },
  {
    id: "package-manager",
    label: "package manager",
    sides: [
      { name: "npm", patterns: [/\bnpm\s+(install|i|run|ci)\b/i, /\buse npm\b/i] },
      { name: "yarn", patterns: [/\byarn\b/i] },
      { name: "pnpm", patterns: [/\bpnpm\b/i] },
      { name: "bun", patterns: [/\bbun\s+(install|run|test)\b/i] },
    ],
  },
  {
    id: "test-runner",
    label: "test runner",
    sides: [
      { name: "jest", patterns: [/\bjest\b/i] },
      { name: "vitest", patterns: [/\bvitest\b/i] },
      { name: "mocha", patterns: [/\bmocha\b/i] },
      { name: "pytest", patterns: [/\bpytest\b/i] },
    ],
  },
  {
    id: "comments",
    label: "code comment policy",
    sides: [
      {
        name: "encourage",
        patterns: [/\b(add|write|include)\b.{0,20}\bcomments?\b/i, /\bdocument every\b/i],
      },
      {
        name: "discourage",
        patterns: [
          /\b(no|avoid|don'?t (add|write)|never (add|write)|minimal)\b.{0,20}\bcomments?\b/i,
          /\bself[- ]documenting\b/i,
        ],
      },
    ],
  },
  {
    id: "commit-style",
    label: "commit message style",
    sides: [
      { name: "conventional", patterns: [/\bconventional commits?\b/i, /\bfeat:|fix:\s/i] },
      { name: "freeform", patterns: [/\b(plain|freeform|descriptive) commit\b/i] },
    ],
  },
  {
    id: "semicolons",
    label: "semicolon usage",
    sides: [
      { name: "require", patterns: [/\b(use|require|always).{0,15}\bsemicolons?\b/i] },
      { name: "omit", patterns: [/\b(no|omit|avoid|without).{0,15}\bsemicolons?\b/i] },
    ],
  },
  {
    id: "type-annotations",
    label: "explicit typing",
    sides: [
      { name: "explicit", patterns: [/\bexplicit(ly)?\s+type|annotate (all|every)\b/i] },
      { name: "inferred", patterns: [/\b(rely on|prefer)\s+(type\s+)?inference\b/i] },
    ],
  },
];

export interface AxisMatch {
  axis: Axis;
  side: AxisSide;
}

/** Which side of which axis (if any) this rule text picks. */
export function classify(text: string, axes: Axis[] = BUILTIN_AXES): AxisMatch[] {
  const out: AxisMatch[] = [];
  for (const axis of axes) {
    const hits = axis.sides.filter((side) => side.patterns.some((p) => p.test(text)));
    // A rule that mentions both sides of an axis ("tabs, not spaces") is making
    // one choice, not conflicting with itself — we cannot tell which side it
    // picked, so we skip rather than guess.
    if (hits.length === 1 && hits[0]) out.push({ axis, side: hits[0] });
  }
  return out;
}

/** Parse user-supplied axes from config (patterns arrive as strings). */
export function parseAxes(raw: unknown): Axis[] {
  if (!Array.isArray(raw)) return [];
  const out: Axis[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e["id"] !== "string" || !Array.isArray(e["sides"])) continue;
    const sides: AxisSide[] = [];
    for (const s of e["sides"]) {
      if (typeof s !== "object" || s === null) continue;
      const sv = s as Record<string, unknown>;
      if (typeof sv["name"] !== "string" || !Array.isArray(sv["patterns"])) continue;
      const patterns: RegExp[] = [];
      for (const p of sv["patterns"]) {
        if (typeof p !== "string") continue;
        try {
          patterns.push(new RegExp(p, "i"));
        } catch {
          // A bad user regex must not crash the run.
        }
      }
      if (patterns.length > 0) sides.push({ name: sv["name"], patterns });
    }
    if (sides.length >= 2) {
      out.push({
        id: e["id"],
        label: typeof e["label"] === "string" ? e["label"] : e["id"],
        sides,
      });
    }
  }
  return out;
}
