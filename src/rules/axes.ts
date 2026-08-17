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
      // No negative lookahead here. It used to read `(?!.*\bnot\b)`, which made
      // the word "tabs" fail to match whenever "not" appeared ANYWHERE later in
      // the rule — so "Use tabs; do not commit generated files" was classified as
      // having no indentation opinion at all. Negation is now resolved centrally
      // in `classify`, against the text preceding each match.
      { name: "tabs", patterns: [/\btabs?\b/i] },
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

/**
 * Words that mark the side named AFTER them as the rejected one.
 *
 * Anchored to the end of the preceding text, so only a cue immediately before
 * the match counts — and bounded to the current clause, since a negation in an
 * earlier sentence says nothing about this mention.
 */
const NEGATION_CUE =
  /\b(?:never|not|no|avoid|without|don'?t|doesn'?t|instead\s+of|rather\s+than|over|versus|vs\.?)\s+[^.;\n]{0,24}$/i;

/** Is at least one mention of this side stated positively rather than rejected? */
function sideIsChosen(text: string, side: AxisSide): boolean {
  for (const pattern of side.patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      if (match.index === undefined) continue;
      if (!NEGATION_CUE.test(text.slice(0, match.index))) return true;
    }
  }
  return false;
}

/**
 * Which side of which axis (if any) this rule text picks.
 *
 * A rule naming both sides used to be skipped outright, on the reasoning that we
 * could not tell which side it had picked. We usually can: "Always indent with
 * tabs, never spaces" names the rejected side right after a negation. Giving up
 * there was costly, because `X, never Y` is one of the most natural ways to write
 * a rule — so the clearest possible statement of a preference was invisible,
 * while the vaguer "Always indent with tabs" was classified fine.
 *
 * Still skipped when negation cannot settle it: no side stated positively, or
 * more than one. Guessing between two positive mentions would invent an opinion
 * the rule does not express.
 */
export function classify(text: string, axes: Axis[] = BUILTIN_AXES): AxisMatch[] {
  const out: AxisMatch[] = [];
  for (const axis of axes) {
    const hits = axis.sides.filter((side) => side.patterns.some((p) => p.test(text)));
    if (hits.length === 0) continue;

    /**
     * Negation is checked even when only one side matched, which matters as much
     * as the both-sides case: "Never use spaces for indentation" mentions exactly
     * one side and *rejects* it. Reading that as a vote FOR spaces turned it into
     * a false conflict against a neighbouring "Always use tabs" — two rules that
     * plainly agree.
     *
     * A lone rejection leaves the rule unclassified rather than inferring the
     * opposite. On a two-sided axis "not spaces" does imply tabs, but axes here
     * can have four sides (package managers), where rejecting one says nothing
     * about which of the rest was chosen.
     */
    const chosen = hits.filter((side) => sideIsChosen(text, side));
    if (chosen.length === 1 && chosen[0]) out.push({ axis, side: chosen[0] });
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
