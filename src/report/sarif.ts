/**
 * SARIF 2.1.0 output, so the GitHub Action can render findings as inline
 * annotations on the diff rather than as a wall of log text.
 */

import { relative } from "node:path";
import { pathToFileURL } from "node:url";

import type { Diagnostic, Severity } from "../model/types.js";

const LEVEL: Record<Severity, string> = {
  error: "error",
  warning: "warning",
  info: "note",
};

export function toSarif(
  diagnostics: Diagnostic[],
  projectRoot: string,
  version: string,
): string {
  const ruleIds = [...new Set(diagnostics.map((d) => d.ruleId))].sort();

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "cclint",
            version,
            informationUri: "https://github.com/Santhosraj/Claude_Linter",
            rules: ruleIds.map((id) => ({
              id,
              shortDescription: { text: describeRule(id) },
              defaultConfiguration: {
                level: LEVEL[defaultSeverityFor(diagnostics, id)],
              },
            })),
          },
        },
        results: diagnostics.map((d) => ({
          ruleId: d.ruleId,
          level: LEVEL[d.severity],
          message: {
            text: d.detail?.length ? `${d.message}\n${d.detail.join("\n")}` : d.message,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: toUri(projectRoot, d.file),
                  uriBaseId: "%SRCROOT%",
                },
                region: d.position
                  ? {
                      startLine: d.position.line,
                      startColumn: d.position.column,
                      ...(d.position.endLine ? { endLine: d.position.endLine } : {}),
                    }
                  : { startLine: 1 },
              },
            },
          ],
          properties: d.data ? { ...d.data, heuristic: d.heuristic === true } : undefined,
        })),
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

function toUri(root: string, file: string): string {
  const rel = relative(root, file);
  // Files outside the repo (user/global config) cannot be annotated on a diff,
  // so we emit an absolute file URI and let the consumer skip them.
  if (rel.startsWith("..")) return pathToFileURL(file).toString();
  return rel.split("\\").join("/");
}

function defaultSeverityFor(diagnostics: Diagnostic[], ruleId: string): Severity {
  return diagnostics.find((d) => d.ruleId === ruleId)?.severity ?? "warning";
}

const DESCRIPTIONS: Record<string, string> = {
  "json/parse-error": "Config file is not valid JSON.",
  "json/not-strict-json":
    "Config file uses JSON extensions (comments or trailing commas) that Claude Code rejects, discarding the whole file.",
  "settings/shadowed-key": "A settings value is overridden by a higher-precedence layer.",
  "settings/unknown-key": "Unrecognised settings key.",
  "hooks/unknown-event": "Hook registered for an event that does not exist.",
  "hooks/unknown-matcher": "Hook matcher does not name a known tool.",
  "hooks/dead-command": "Hook points at a script that does not exist.",
  "hooks/command-not-on-path": "Hook command was not found on PATH.",
  "hooks/malformed": "Hook entry does not match the expected schema.",
  "mcp/malformed": "MCP server entry does not match the expected schema.",
  "mcp/invalid-type": "MCP server declares an unknown transport type.",
  "mcp/invalid-url": "MCP server url is unparseable.",
  "mcp/duplicate-server": "MCP server name is defined in more than one scope.",
  "mcp/command-not-on-path": "MCP server binary was not found on PATH.",
  "mcp/unset-env-var": "MCP config references an environment variable that is unset.",
  "permissions/untrusted-workspace": "Project-level permissions.allow entries are ignored because the workspace is not trusted.",
  "permissions/duplicate-entry": "The same permission entry is listed more than once.",
  "permissions/redundant-entry": "A permission entry is already covered by a broader rule.",
  "permissions/dead-path": "A permission entry points at a path that does not exist on this machine.",
  "memory/dead-import": "CLAUDE.md imports a file that does not exist.",
  "memory/import-cycle": "CLAUDE.md imports form a cycle.",
  "memory/duplicate-rule": "The same rule is stated twice in one file.",
  "memory/redundant-across-layers": "The same rule is stated in two files both always in context.",
  "memory/axis-conflict": "Two rules pick opposite sides of a known decision.",
};

function describeRule(id: string): string {
  return DESCRIPTIONS[id] ?? id;
}
