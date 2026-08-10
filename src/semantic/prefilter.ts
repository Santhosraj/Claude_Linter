/**
 * Deterministic prefilter for the semantic pass.
 *
 * This is what keeps the LLM layer cheap and bounded: instead of asking a model
 * about every pair of rules (O(n²) requests), we use an inverted index to
 * surface only pairs that share enough topical vocabulary to be plausibly about
 * the same thing. Everything else never reaches the model.
 *
 * The prefilter is intentionally high-recall and low-precision — its job is to
 * avoid missing real conflicts, and the adjudicator's job is to throw out the
 * noise it lets through.
 */

import { classify, type Axis } from "../rules/axes.js";
import type { MemoryRule } from "../model/types.js";
import type { CandidatePair } from "./adjudicate.js";

const STOPWORDS = new Set([
  "a", "all", "also", "always", "an", "and", "any", "are", "as", "at", "avoid", "be",
  "before", "both", "but", "by", "can", "do", "does", "dont", "each", "ensure", "every",
  "first", "for", "from", "has", "have", "if", "in", "into", "is", "it", "its", "make",
  "must", "never", "no", "not", "of", "on", "only", "or", "our", "prefer", "should", "so",
  "sure", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "to", "up", "use", "used", "using", "we", "when", "which", "while", "will", "with",
  "would", "you", "your",
]);

export interface PrefilterOptions {
  axes: Axis[];
  /** Minimum shared significant terms for a pair to be worth judging. */
  minSharedTerms?: number;
  maxPairs?: number;
  /**
   * How many candidate pairs any single rule may occupy.
   *
   * Without this, one long rule swallows the entire budget. Measured on a real
   * 144-rule CLAUDE.md: two verbose paragraphs took 40 of the 80 pair slots —
   * one alone appeared in 57% of pairs — because long text shares common words
   * with everything. The judged pairs were then almost all "that paragraph vs
   * something unrelated", every one correctly answered "different topics",
   * while 142 rules were never compared to each other at all.
   */
  maxPairsPerRule?: number;
}

export function buildCandidatePairs(
  rules: MemoryRule[],
  options: PrefilterOptions,
): CandidatePair[] {
  const minShared = options.minSharedTerms ?? 2;
  const maxPairs = options.maxPairs ?? 200;
  const maxPerRule = options.maxPairsPerRule ?? 3;

  const terms = rules.map((r) => significantTerms(r.normalized));
  const axisIds = rules.map((r) => new Set(classify(r.text, options.axes).map((m) => m.axis.id)));

  // Inverted index: term → rule indices. Lets us consider only rules that share
  // at least one term instead of every pair.
  const index = new Map<string, number[]>();
  terms.forEach((set, i) => {
    for (const term of set) {
      const list = index.get(term) ?? [];
      list.push(i);
      index.set(term, list);
    }
  });

  // Second index: axis id → rule indices.
  //
  // Without this, axis-based pairing is unreachable — a pair only ever became a
  // candidate by sharing vocabulary, so "Always use tabs" vs "Use 2-space
  // indentation" (which share no significant terms at all) was silently never
  // surfaced. Two rules landing on the same known decision axis is a candidate
  // signal in its own right, independent of wording.
  const axisIndex = new Map<string, number[]>();
  axisIds.forEach((ids, i) => {
    for (const id of ids) {
      const list = axisIndex.get(id) ?? [];
      list.push(i);
      axisIndex.set(id, list);
    }
  });

  const scored = new Map<string, { i: number; j: number; shared: string[] }>();

  const consider = (i: number, j: number) => {
    const [lo, hi] = i < j ? [i, j] : [j, i];
    const key = `${lo}:${hi}`;
    if (scored.has(key)) return;
    scored.set(key, { i: lo, j: hi, shared: [...intersect(terms[lo]!, terms[hi]!)] });
  };

  for (const [, members] of index) {
    // A term that appears in almost every rule ("code", "file") carries no
    // signal and would blow up the pair count.
    if (members.length > 25) continue;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) consider(members[a]!, members[b]!);
    }
  }

  for (const [, members] of axisIndex) {
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) consider(members[a]!, members[b]!);
    }
  }

  /**
   * Rarity weight for a term.
   *
   * A term in almost every rule ("test", "run", "file") says nothing about
   * whether two rules are about the same thing; a term in two rules says a lot.
   * Weighting by rarity is what stops long, word-rich paragraphs outranking
   * short rules that genuinely overlap.
   */
  const docFreq = new Map<string, number>();
  for (const set of terms) for (const t of set) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  const rarity = (term: string) =>
    Math.log(rules.length / Math.max(1, docFreq.get(term) ?? 1));

  const candidates: { pair: CandidatePair; score: number }[] = [];

  for (const { i, j, shared } of scored.values()) {
    const a = rules[i]!;
    const b = rules[j]!;

    // Two bullets under the same heading in the same file are almost always one
    // coherent instruction, not a conflict. Skipping them is the single biggest
    // precision win available to the prefilter.
    if (a.file === b.file && a.headings.join("/") === b.headings.join("/")) continue;

    // Identical rules are handled by the duplicate detector, not here.
    if (a.normalized === b.normalized) continue;

    const sharedAxis = [...axisIds[i]!].find((id) => axisIds[j]!.has(id));

    if (sharedAxis) {
      candidates.push({
        pair: {
          a,
          b,
          reason: `both rules mention the same known decision axis ("${sharedAxis}")`,
        },
        // An explicit axis match is the strongest signal available, so it
        // outranks any amount of incidental vocabulary overlap.
        score: 1000,
      });
      continue;
    }

    if (shared.length >= minShared) {
      candidates.push({
        pair: {
          a,
          b,
          reason: `they share the terms ${shared.slice(0, 5).map((t) => `"${t}"`).join(", ")}`,
        },
        score: shared.reduce((n, t) => n + rarity(t), 0),
      });
    }
  }

  // Rank by signal, then break ties deterministically so cached runs and CI
  // output stay stable.
  candidates.sort((p, q) => {
    if (q.score !== p.score) return q.score - p.score;
    const byFile =
      p.pair.a.file.localeCompare(q.pair.a.file) || p.pair.b.file.localeCompare(q.pair.b.file);
    if (byFile !== 0) return byFile;
    return (
      p.pair.a.position.line - q.pair.a.position.line ||
      p.pair.b.position.line - q.pair.b.position.line
    );
  });

  // Greedy selection under a per-rule cap: take the best pairs first, but stop
  // admitting any rule once it already has `maxPerRule` pairs. This spends the
  // budget across many rules instead of exhausting it on one wordy paragraph.
  const used = new Map<string, number>();
  const chosen: CandidatePair[] = [];

  for (const { pair } of candidates) {
    if (chosen.length >= maxPairs) break;
    const ka = ruleKey(pair.a);
    const kb = ruleKey(pair.b);
    if ((used.get(ka) ?? 0) >= maxPerRule) continue;
    if ((used.get(kb) ?? 0) >= maxPerRule) continue;
    used.set(ka, (used.get(ka) ?? 0) + 1);
    used.set(kb, (used.get(kb) ?? 0) + 1);
    chosen.push(pair);
  }

  return chosen;
}

function ruleKey(rule: MemoryRule): string {
  return `${rule.file}:${rule.position.line}:${rule.normalized}`;
}

export function significantTerms(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const word of normalized.split(" ")) {
    if (word.length < 3) continue;
    if (STOPWORDS.has(word)) continue;
    out.add(stem(word));
  }
  return out;
}

/** Crude suffix stripping — enough to match "comment"/"comments"/"commenting". */
function stem(word: string): string {
  for (const suffix of ["ing", "ies", "es", "ed", "s"]) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}
