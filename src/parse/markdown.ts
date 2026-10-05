/**
 * A purpose-built CLAUDE.md scanner.
 *
 * We hand-roll rather than pulling in remark/unified because we need exactly
 * three things — headings, directive-bearing blocks, and `@path` imports — and
 * a line scanner gives us byte-exact positions with zero dependency surface.
 * The one thing we must not get wrong is fenced code blocks: content inside
 * ``` fences is example code, not instructions to Claude, and treating it as a
 * rule is a false-positive factory.
 */

import type { MemoryRule, Position } from "../model/types.js";

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/;
/** `@path/to/file.md` import, at the start of a line (optionally in a list). */
const IMPORT = /^\s*(?:[-*+]\s+)?@([^\s`]+)\s*$/;

/**
 * Lines that are document structure, never instructions. Each used to fall
 * through to the paragraph accumulator: a `---` separator became a "paragraph"
 * (33 of them in one real corpus), and a table row was glued onto the prose
 * around it — so a table cell containing "use" or "run" became a rule.
 */
const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|/;
/** A comment that STARTS the line. Inline ones are stripped by stripInline, so
 *  `Always use tabs <!-- legacy -->` keeps its rule. */
const HTML_COMMENT_OPEN = /^\s*<!--/;
const HTML_COMMENT_CLOSE = /-->/;

export interface ScannedMarkdown {
  headings: { text: string; depth: number; position: Position }[];
  blocks: DirectiveBlock[];
  imports: { target: string; position: Position }[];
}

export interface DirectiveBlock {
  text: string;
  position: Position;
  headings: string[];
  kind: "listItem" | "paragraph";
}

export function scanMarkdown(text: string): ScannedMarkdown {
  const lines = text.split(/\r?\n/);
  const headings: ScannedMarkdown["headings"] = [];
  const blocks: DirectiveBlock[] = [];
  const imports: ScannedMarkdown["imports"] = [];

  let fence: string | undefined;
  const headingStack: { depth: number; text: string }[] = [];

  // Paragraph accumulator — consecutive non-blank, non-list lines.
  let paraLines: string[] = [];
  let paraStart = 0;

  // The list item still open for continuation lines.
  //
  // A bullet wrapped across lines is ONE rule. Without this, every wrapped
  // bullet was split at the physical newline into a truncated list item plus a
  // headless paragraph — measured at 34 of 141 rules in a real CLAUDE.md. Both
  // halves are sentence fragments, which poisons everything downstream: the
  // semantic judge was handed rules ending mid-clause, duplicate detection
  // compared partial text, and axis classification could miss the very word
  // that identified the rule's side.
  let openList: { block: DirectiveBlock; indent: number } | undefined;

  /** Inside a multi-line `<!-- ... -->`, which is invisible to the reader. */
  let inComment = false;

  // YAML frontmatter is metadata, not prose. Without this, `name: ...` and
  // `description: ...` were glued into a paragraph and read as a rule. Only at
  // the very start of the file, and only if it actually closes — an unclosed
  // `---` on line 1 is just a separator.
  let start = 0;
  if ((lines[0] ?? "").trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (close > 0) start = close + 1;
  }

  const flushParagraph = () => {
    if (paraLines.length === 0) return;
    const joined = paraLines.join(" ").trim();
    if (joined.length > 0) {
      blocks.push({
        text: joined,
        position: { line: paraStart + 1, column: 1, endLine: paraStart + paraLines.length },
        headings: headingStack.map((h) => h.text),
        kind: "paragraph",
      });
    }
    paraLines = [];
  };

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i] ?? "";

    // --- fenced code blocks: everything inside is inert -----------------
    const fenceMatch = FENCE.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[2] ?? "";
      if (fence === undefined) {
        flushParagraph();
        // Prose after a fenced example is not a continuation of the bullet that
        // preceded the fence.
        openList = undefined;
        fence = marker[0];
      } else if (marker[0] === fence) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) continue;

    // --- structure that is never an instruction -------------------------
    // Treated like a blank line: it ends the paragraph or bullet it follows,
    // rather than being glued onto either.
    if (inComment) {
      if (HTML_COMMENT_CLOSE.test(raw)) inComment = false;
      continue;
    }
    if (HTML_COMMENT_OPEN.test(raw)) {
      flushParagraph();
      openList = undefined;
      // Only a comment that does not close on this line spans the next ones.
      const afterOpen = raw.slice(raw.indexOf("<!--") + 4);
      if (!HTML_COMMENT_CLOSE.test(afterOpen)) inComment = true;
      continue;
    }
    if (THEMATIC_BREAK.test(raw) || TABLE_ROW.test(raw)) {
      flushParagraph();
      openList = undefined;
      continue;
    }

    // --- imports --------------------------------------------------------
    const importMatch = IMPORT.exec(raw);
    if (importMatch?.[1]) {
      flushParagraph();
      openList = undefined;
      imports.push({
        target: importMatch[1],
        position: { line: i + 1, column: raw.indexOf("@") + 1 },
      });
      continue;
    }

    // --- headings -------------------------------------------------------
    const headingMatch = HEADING.exec(raw);
    if (headingMatch) {
      flushParagraph();
      openList = undefined;
      const depth = (headingMatch[1] ?? "#").length;
      const htext = stripInline(headingMatch[2] ?? "");
      headings.push({ text: htext, depth, position: { line: i + 1, column: 1 } });
      while (headingStack.length > 0 && (headingStack.at(-1)?.depth ?? 0) >= depth) {
        headingStack.pop();
      }
      headingStack.push({ depth, text: htext });
      continue;
    }

    // --- list items -----------------------------------------------------
    const listMatch = LIST_ITEM.exec(raw);
    if (listMatch?.[2]) {
      flushParagraph();
      const indent = (listMatch[1] ?? "").length;
      const block: DirectiveBlock = {
        text: stripInline(listMatch[2]),
        position: { line: i + 1, column: indent + 1, endLine: i + 1 },
        headings: headingStack.map((h) => h.text),
        kind: "listItem",
      };
      blocks.push(block);
      openList = { block, indent };
      continue;
    }

    // --- blank line ends a paragraph ------------------------------------
    if (raw.trim().length === 0) {
      flushParagraph();
      openList = undefined;
      continue;
    }

    // --- continuation of the open list item -------------------------------
    // Indented deeper than its marker, so it belongs to that bullet rather
    // than starting a paragraph. Lazy (unindented) continuation is legal
    // CommonMark but is indistinguishable from a new paragraph here, and
    // wrongly swallowing a paragraph is the worse error.
    if (openList && leadingSpaces(raw) > openList.indent) {
      openList.block.text = `${openList.block.text} ${stripInline(raw.trim())}`.trim();
      openList.block.position.endLine = i + 1;
      continue;
    }
    openList = undefined;

    if (paraLines.length === 0) paraStart = i;
    paraLines.push(stripInline(raw.trim()));
  }
  flushParagraph();

  return { headings, blocks, imports };
}

/**
 * Drop `<!-- ... -->`, which the reader never sees — but not inside a code span,
 * where it is an example the rule is talking about: "wrap generated sections in
 * `<!-- gen:start -->`" must keep its marker. Odd indices of the split are the
 * backtick spans themselves.
 */
function stripHtmlComments(s: string): string {
  return s
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/<!--[\s\S]*?-->/g, "")))
    .join("");
}

function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/** Strip inline markdown so normalization and display are stable. */
export function stripInline(s: string): string {
  return stripHtmlComments(s)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/__([^_]*)__/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

/**
 * Canonical form used for duplicate/near-duplicate detection.
 * Aggressive on purpose — we want "Always use tabs." and "always use tabs"
 * to collide, because that IS the redundancy we're reporting.
 */
export function normalizeRule(s: string): string {
  return stripInline(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does this block read like an instruction to the model, rather than prose
 * describing the project?
 *
 * This used to be ONLY the hint-word test below, on the reasoning that "a false
 * negative costs us one missed duplicate". That was backwards. A block rejected
 * here is never a rule at all, so it vanishes from duplicate detection, the axis
 * check and the semantic pass together — silently. Measured on 11 real
 * CLAUDE.md files, 70% of blocks were rejected, and in five of them 94–100%
 * were: one file of 11 blocks produced zero rules, so every memory check saw an
 * empty file and reported it clean. The commonest casualty was the plainest
 * instruction there is — an imperative with no hint word in it: "Keep every
 * function under 20 lines", "Store all timestamps in UTC", "Pin direct
 * dependencies to exact versions".
 *
 * The cost runs the other way. A description wrongly admitted as a rule can
 * only surface as a finding if it is duplicated verbatim in another
 * always-loaded file (which is real token waste anyway) or sides with an axis
 * against a rule that opposes it (which is a real contradiction in context
 * anyway). So the test now admits anything that reads as an instruction, and
 * relies on the scanner to exclude structure — separators, tables, comments.
 */
const DIRECTIVE_HINT =
  /\b(always|never|must|should|do not|don't|avoid|prefer|use|run|write|ensure|make sure|required|forbidden|only|first|before|after|instead)\b/i;

/**
 * Base-form verbs that open an instruction. A closed list on purpose: guessing
 * the part of speech of an arbitrary first word is how prose like "Payments flow
 * through Stripe" would get in. Words that are also common nouns ("build",
 * "test", "document") are kept, and the copula check below catches the noun
 * reading: "Build output is in dist/" is a description, "Build with --release"
 * is an instruction.
 */
const IMPERATIVE_VERBS = new Set([
  "add", "adjust", "align", "annotate", "apply", "archive", "ask", "assert", "assess", "assume",
  "be", "bump", "build", "bundle", "cache", "call", "cap", "capture", "catch", "change",
  "check", "choose", "clean", "clear", "clone", "close", "collect", "comment", "commit",
  "compare", "compile", "configure", "confirm", "connect", "consider", "convert", "copy",
  "create", "debug", "declare", "default", "define", "delete", "deploy", "describe",
  "detect", "disable", "document", "do", "drop", "edit", "emit", "enable", "encode",
  "enforce", "escape", "evaluate", "exclude", "execute", "explain", "expose", "extend", "extract", "favor",
  "favour", "fetch", "fill", "filter", "find", "fix", "flag", "follow", "force", "format",
  "generate", "give", "guard", "handle", "hide", "ignore", "implement", "import", "include",
  "increment", "inline", "insert", "inspect", "install", "investigate", "invoke", "isolate", "justify", "keep",
  "label", "leave", "let", "limit", "link", "lint", "list", "load", "lock", "log", "look",
  "maintain", "make", "mark", "match", "measure", "mention", "merge", "migrate", "minimize", "mock",
  "move", "name", "normalize", "note", "notify", "omit", "open", "order", "organize",
  "override", "pass", "patch", "pick", "pin", "place", "plan", "point", "populate", "post",
  "prepare", "preserve", "prevent", "print", "prioritize", "propagate", "protect",
  "provide", "publish", "pull", "push", "put", "raise", "read", "rebase", "rebuild",
  "record", "redact", "reduce", "refactor", "refer", "register", "reject", "release",
  "reload", "remember", "remove", "rename", "render", "reorder", "repeat", "replace", "reply",
  "report", "request", "require", "reset", "resolve", "respect", "respond", "restart",
  "restore", "retry", "return", "reuse", "review", "revert", "rewrite", "rotate", "route",
  "save", "scan", "schedule", "scope", "search", "see", "select", "send", "separate",
  "serve", "set", "ship", "show", "skip", "sort", "specify", "split", "squash", "stage",
  "start", "stay", "stop", "store", "strip", "stub", "submit", "suggest", "summarize", "surface",
  "switch", "sync", "tag", "take", "target", "tell", "test", "throw", "trace", "track",
  "treat", "trigger", "trim", "try", "turn", "update", "upgrade", "upload", "validate",
  "verify", "wait", "warn", "watch", "wrap",
]);

/** Right after an opener, these mean it was a noun: "Test suite is slow". */
const COPULA = new Set([
  "is", "are", "was", "were", "has", "have", "had", "will", "would", "can", "could", "may", "might",
]);

/**
 * Where a fresh instruction can start inside one block: a new sentence, after a
 * dash or arrow ("Bugs → invoke /investigate", "await — remove it"), after a
 * label ("Workflow: push the branch"), or inside parentheses ("(If yes, bump
 * the version.)"). Commas are NOT boundaries in general — "Branch resyncs, merge
 * commits, rebase activity" is a list of nouns, and splitting it would read
 * "merge" as a verb. Commas count only after a leading condition; see below.
 */
const CLAUSE_BOUNDARY = /[.!?]\s+|\s[—–]\s|\s*(?:→|->)\s*|;\s+|:\s+|\(/;

/** "When merging main brings a higher VERSION, re-evaluate the bump." */
const CONDITION = /^(?:if|when|whenever|unless|once|while)\b[^,]*,\s*(.+)$/i;

function opensWithImperative(clause: string): boolean {
  const words = clause.replace(/^[^\p{L}]+/u, "").split(/\s+/);
  const raw = words[0] ?? "";
  // An all-caps word is a constant or acronym — `WARN: 0.75`, `PATCH (X.Y.Z)` —
  // not an instruction. Nobody writes imperatives in caps except for emphasis,
  // and the emphasised ones ("NEVER", "DO NOT") are already hint words.
  if (raw.length > 1 && raw === raw.toUpperCase() && /\p{L}/u.test(raw)) return false;
  const first = raw.toLowerCase().replace(/[^\p{L}-]/gu, "");
  if (first.length === 0) return false;
  // "Squash-merge" and "re-evaluate" are verbs whose first segment, or whose
  // stem without "re-", is in the list.
  const candidates = [first, first.split("-")[0] ?? "", first.replace(/^re-/, "")];
  const verb = candidates.some((c) => IMPERATIVE_VERBS.has(c));
  // "No jargon", "No edits to ETHOS.md": a prohibition with no hint word.
  if (!verb && first !== "no") return false;
  const following = words.slice(1, 3).map((w) => w.toLowerCase().replace(/[^\p{L}]/gu, ""));
  return !following.some((w) => COPULA.has(w));
}

export function looksDirective(text: string): boolean {
  if (text.length < 8) return false;
  if (DIRECTIVE_HINT.test(text)) return true;
  return text
    .split(CLAUSE_BOUNDARY)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .some((c) => {
      if (opensWithImperative(c)) return true;
      const conditional = CONDITION.exec(c);
      return conditional?.[1] !== undefined && opensWithImperative(conditional[1]);
    });
}

export function toRules(
  scanned: ScannedMarkdown,
  file: string,
  layer: MemoryRule["layer"],
): MemoryRule[] {
  const rules: MemoryRule[] = [];
  for (const block of scanned.blocks) {
    if (!looksDirective(block.text)) continue;
    rules.push({
      text: block.text,
      normalized: normalizeRule(block.text),
      file,
      layer,
      position: block.position,
      headings: block.headings,
    });
  }
  return rules;
}
