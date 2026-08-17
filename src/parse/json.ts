/**
 * Position-preserving JSON parsing.
 *
 * We parse leniently so that ONE syntax mistake does not blind every other rule
 * — and because `JSON.parse` discards positions, which would make findings
 * unanchorable and CI annotations impossible.
 *
 * But leniency must not become tolerance. Claude Code parses its settings files
 * as STRICT JSON: a single `//` comment or trailing comma makes it discard the
 * entire file, silently, taking every setting in it with it. Verified against
 * `claude doctor`, which reports "Invalid or malformed JSON" for both — see the
 * recorded complaints in each fixture's `.conformance/doctor.json`, which also
 * carry the version they came from.
 *
 * So we read the file leniently and then report the extensions as an error.
 * Staying quiet here would be the worst possible outcome: cclint would parse a
 * file Claude Code has thrown away and cheerfully report its settings as live.
 */

import {
  findNodeAtLocation,
  parseTree,
  parse as parseJsonc,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";

import type { Diagnostic, Position } from "../model/types.js";

export interface ParsedJson {
  file: string;
  text: string;
  value: Record<string, unknown> | undefined;
  root: Node | undefined;
  errors: Diagnostic[];
  /** Cached newline offsets for O(log n) offset → line/col conversion. */
  lineStarts: number[];
}

export function parseJsonFile(file: string, text: string): ParsedJson {
  const parseErrors: ParseError[] = [];
  const value = parseJsonc(text, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as Record<string, unknown> | undefined;

  const root = parseTree(text, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });

  const lineStarts = computeLineStarts(text);

  const errors: Diagnostic[] = parseErrors.map((e) => ({
    ruleId: "json/parse-error",
    severity: "error" as const,
    message: `Malformed JSON: ${printParseErrorCode(e.error)}.`,
    file,
    position: offsetToPosition(lineStarts, e.offset, e.length),
  }));

  // Only worth checking if the file otherwise parsed — a file that is already
  // broken does not need a second opinion about why.
  if (parseErrors.length === 0) {
    errors.push(...strictJsonViolations(file, text, lineStarts));
  }

  return { file, text, value, root, errors, lineStarts };
}

/**
 * Report JSON extensions that Claude Code rejects outright.
 *
 * Each extension gets its own parse with only that tolerance disabled, so the
 * error set is unambiguously attributable. The obvious alternative — one strict
 * parse, then classifying by error name — does not work: jsonc-parser reports a
 * trailing comma as `PropertyNameExpected` / `ValueExpected`, names that say
 * nothing about commas, so a name-matching version silently missed every
 * trailing comma while appearing to work.
 */
function strictJsonViolations(
  file: string,
  text: string,
  lineStarts: number[],
): Diagnostic[] {
  const detail = [
    "Claude Code parses settings as strict JSON. One comment or trailing comma " +
      "invalidates the entire file, so every setting in it silently stops applying.",
    "`claude doctor` reports this as: Invalid or malformed JSON.",
  ];

  const out: Diagnostic[] = [];
  const seen = new Set<string>();

  const collect = (
    options: { allowTrailingComma: boolean; disallowComments: boolean },
    message: string,
    anchorToPrecedingComma = false,
  ) => {
    const errors: ParseError[] = [];
    parseJsonc(text, errors, options);
    for (const e of errors) {
      // The parser reports a trailing comma where it NOTICED the problem — at
      // the closing brace — not where the comma is. Point at the character the
      // user has to delete instead.
      const offset = anchorToPrecedingComma ? precedingComma(text, e.offset) : e.offset;
      const key = `${message}:${offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ruleId: "json/not-strict-json",
        severity: "error",
        message,
        file,
        position: offsetToPosition(lineStarts, offset, anchorToPrecedingComma ? 1 : e.length),
        detail,
      });
    }
  };

  collect(
    { allowTrailingComma: true, disallowComments: true },
    "Comments are not allowed here — Claude Code discards the whole file.",
  );
  collect(
    { allowTrailingComma: false, disallowComments: false },
    "Trailing comma is not allowed here — Claude Code discards the whole file.",
    true,
  );

  // A trailing comma yields several errors at one offset; keep one per position.
  return dedupeByPosition(out);
}

/**
 * Walk backwards from `offset` over whitespace to the comma that caused the
 * error. Falls back to the original offset when there is no comma there, so a
 * surprising parse shape degrades to a slightly-off position rather than a
 * wrong one.
 */
function precedingComma(text: string, offset: number): number {
  let i = Math.min(offset, text.length) - 1;
  while (i >= 0 && /\s/.test(text[i] ?? "")) i--;
  return i >= 0 && text[i] === "," ? i : offset;
}

function dedupeByPosition(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.position?.line}:${d.position?.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Find the source position of a dotted path within a parsed file.
 * Returns undefined when the path is absent — callers fall back to the file
 * position rather than inventing a line number.
 */
export function positionOf(parsed: ParsedJson, path: string): Position | undefined {
  if (!parsed.root) return undefined;
  const segments = toSegments(path);
  const node = findNodeAtLocation(parsed.root, segments);
  if (!node) return undefined;
  return offsetToPosition(parsed.lineStarts, node.offset, node.length);
}

/** Position of the *key* rather than the value — nicer for annotations. */
export function keyPositionOf(parsed: ParsedJson, path: string): Position | undefined {
  if (!parsed.root) return undefined;
  const segments = toSegments(path);
  const node = findNodeAtLocation(parsed.root, segments);
  if (!node) return undefined;
  const property = node.parent;
  if (property?.type === "property" && property.children?.[0]) {
    const keyNode = property.children[0];
    return offsetToPosition(parsed.lineStarts, keyNode.offset, keyNode.length);
  }
  return offsetToPosition(parsed.lineStarts, node.offset, node.length);
}

function toSegments(path: string): (string | number)[] {
  return path
    .split(".")
    .filter((s) => s.length > 0)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

export function offsetToPosition(
  lineStarts: number[],
  offset: number,
  length = 0,
): Position {
  const start = locate(lineStarts, offset);
  const end = locate(lineStarts, offset + length);
  return {
    line: start.line,
    column: start.column,
    offset,
    endLine: end.line,
    endColumn: end.column,
  };
}

function locate(lineStarts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (lineStarts[lo] ?? 0) + 1 };
}
