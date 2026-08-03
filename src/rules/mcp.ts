/**
 * MCP configuration checks (.mcp.json, and the mcpServers block in ~/.claude.json).
 *
 * Findings here are validated against a real oracle: `claude mcp list` resolves
 * the same layered config Claude Code uses at runtime and reports which servers
 * it accepted and which it skipped — without making an API call. The
 * conformance suite asserts we agree with it in both directions. See
 * scripts/oracle.ts.
 */

import { readFileSync } from "node:fs";

import { relative } from "../discovery/layers.js";
import { keyPositionOf, parseJsonFile, type ParsedJson } from "../parse/json.js";
import { isPlainObject } from "../resolve/settings.js";
import { firstToken, onPath } from "./hooks.js";
import { SEVERITY, type RuleContext } from "./context.js";
import type { Diagnostic, Position } from "../model/types.js";

const VALID_TYPES = new Set(["stdio", "sse", "http"]);
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

interface ServerCtx {
  name: string;
  config: Record<string, unknown>;
  path: string;
  file: string;
  parsed: ParsedJson;
}

export function mcpRules(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const root = ctx.discovery.projectRoot;

  /** server name → where we first saw it, for cross-scope collision detection. */
  const seen = new Map<string, { file: string; scope: string }>();

  for (const entry of ctx.discovery.mcp) {
    let text: string;
    try {
      text = readFileSync(entry.file, "utf8");
    } catch {
      continue;
    }

    const parsed = parseJsonFile(entry.file, text);
    out.push(...parsed.errors);
    if (!parsed.value) continue;

    const servers = parsed.value["mcpServers"];
    if (servers === undefined) continue;

    if (!isPlainObject(servers)) {
      out.push({
        ruleId: "mcp/malformed",
        severity: SEVERITY.deterministic,
        message: "`mcpServers` must be an object keyed by server name.",
        file: entry.file,
        position: keyPositionOf(parsed, "mcpServers"),
      });
      continue;
    }

    const scope = entry.layer === "user" ? "user" : "project";

    for (const [name, config] of Object.entries(servers)) {
      const path = `mcpServers.${name}`;
      const findings: Diagnostic[] = [];

      // --- duplicate server names across scopes ---------------------------
      const prior = seen.get(name);
      if (prior && prior.file !== entry.file) {
        findings.push({
          ruleId: "mcp/duplicate-server",
          severity: SEVERITY.environmental,
          message: `MCP server "${name}" is defined in more than one scope.`,
          file: entry.file,
          position: keyPositionOf(parsed, path),
          detail: [
            `Also defined in ${relative(root, prior.file)} (${prior.scope} scope).`,
            "Tool names are namespaced by server, so one definition wins and the other's tools never appear.",
          ],
          data: { otherFile: prior.file },
        });
      } else if (!prior) {
        seen.set(name, { file: entry.file, scope });
      }

      if (!isPlainObject(config)) {
        findings.push({
          ruleId: "mcp/malformed",
          severity: SEVERITY.deterministic,
          message: `MCP server "${name}" must be an object.`,
          file: entry.file,
          position: keyPositionOf(parsed, path),
        });
      } else {
        findings.push(...checkServer({ name, config, path, file: entry.file, parsed }));
      }

      // Every finding carries its server name, so the conformance harness can
      // line our verdicts up against the oracle's per-server results.
      for (const f of findings) f.data = { ...f.data, server: name };
      out.push(...findings);
    }
  }

  return out;
}

function checkServer(s: ServerCtx): Diagnostic[] {
  const out: Diagnostic[] = [];
  const at = (p: string): Position | undefined => keyPositionOf(s.parsed, p);

  const type = s.config["type"];
  const hasCommand = typeof s.config["command"] === "string";
  const hasUrl = typeof s.config["url"] === "string";

  // --- unknown transport type ----------------------------------------------
  if (typeof type === "string" && !VALID_TYPES.has(type)) {
    // Return immediately: Claude Code skips a server with an unknown type
    // outright, so its transport shape is moot. Also reporting "websocket but
    // has no url" would be two findings for one defect — the conformance suite
    // asserts we emit exactly one, matching `claude mcp list`.
    return [
      {
        ruleId: "mcp/invalid-type",
        severity: SEVERITY.deterministic,
        message: `MCP server "${s.name}" has unknown type "${type}".`,
        file: s.file,
        position: at(`${s.path}.type`),
        detail: [
          `Expected one of: ${[...VALID_TYPES].join(", ")}`,
          "Claude Code skips this server entirely.",
        ],
        data: { type },
      },
    ];
  }

  const effectiveType =
    typeof type === "string" ? type : hasUrl ? "http" : hasCommand ? "stdio" : undefined;

  if (effectiveType === undefined) {
    return [
      {
        ruleId: "mcp/malformed",
        severity: SEVERITY.deterministic,
        message: `MCP server "${s.name}" declares neither \`command\` (stdio) nor \`url\` (sse/http).`,
        file: s.file,
        position: at(s.path),
      },
    ];
  }

  // --- transport shape ------------------------------------------------------
  if (effectiveType === "stdio") {
    if (!hasCommand) {
      out.push({
        ruleId: "mcp/malformed",
        severity: SEVERITY.deterministic,
        message: `MCP server "${s.name}" is stdio but has no \`command\`.`,
        file: s.file,
        position: at(s.path),
      });
    } else {
      out.push(
        ...checkBinary(String(s.config["command"]), s.name, s.file, at(`${s.path}.command`)),
      );
    }

    const args = s.config["args"];
    if (args !== undefined && !Array.isArray(args)) {
      out.push({
        ruleId: "mcp/malformed",
        severity: SEVERITY.deterministic,
        message: `MCP server "${s.name}": \`args\` must be an array.`,
        file: s.file,
        position: at(`${s.path}.args`),
      });
    }
  } else if (!hasUrl) {
    out.push({
      ruleId: "mcp/malformed",
      severity: SEVERITY.deterministic,
      message: `MCP server "${s.name}" is ${effectiveType} but has no \`url\`.`,
      file: s.file,
      position: at(s.path),
    });
  } else {
    const url = String(s.config["url"]);
    try {
      new URL(url);
    } catch {
      out.push({
        ruleId: "mcp/invalid-url",
        severity: SEVERITY.deterministic,
        message: `MCP server "${s.name}" has an unparseable url: ${url}`,
        file: s.file,
        position: at(`${s.path}.url`),
      });
    }
  }

  out.push(...checkEnvRefs(s));
  return out;
}

function checkBinary(
  command: string,
  server: string,
  file: string,
  position: Position | undefined,
): Diagnostic[] {
  const bin = firstToken(command);
  if (!bin) return [];
  if (bin.includes("/") || bin.includes("\\") || bin.startsWith(".")) return []; // path form
  if (bin.includes("$")) return []; // env-interpolated, not statically checkable
  if (onPath(bin)) return [];

  return [
    {
      ruleId: "mcp/command-not-on-path",
      severity: SEVERITY.environmental,
      message: `MCP server "${server}" runs "${bin}", which was not found on PATH.`,
      file,
      position,
      detail: ["The server will fail to start unless this binary exists at runtime."],
      heuristic: true,
      data: { binary: bin },
    },
  ];
}

/**
 * Flag `$VAR` references that are unset here.
 *
 * Environmental, never deterministic: the variable may well be set on the
 * machine that actually launches the server. `claude mcp list` accepts these
 * servers, and the conformance suite would flag it as a false positive if we
 * ever promoted this to an error.
 */
function checkEnvRefs(s: ServerCtx): Diagnostic[] {
  const out: Diagnostic[] = [];
  const candidates: { value: string; subPath: string }[] = [];

  const env = s.config["env"];
  if (isPlainObject(env)) {
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string") candidates.push({ value: v, subPath: `${s.path}.env.${k}` });
    }
  }
  if (typeof s.config["url"] === "string") {
    candidates.push({ value: s.config["url"], subPath: `${s.path}.url` });
  }
  if (Array.isArray(s.config["args"])) {
    s.config["args"].forEach((a, i) => {
      if (typeof a === "string") candidates.push({ value: a, subPath: `${s.path}.args.${i}` });
    });
  }

  const reported = new Set<string>();
  for (const candidate of candidates) {
    ENV_REF.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ENV_REF.exec(candidate.value)) !== null) {
      const varName = match[1] ?? match[2];
      if (!varName || reported.has(varName)) continue;
      if (process.env[varName] !== undefined) continue;
      reported.add(varName);
      out.push({
        ruleId: "mcp/unset-env-var",
        severity: SEVERITY.environmental,
        message: `MCP server "${s.name}" references $${varName}, which is unset in this environment.`,
        file: s.file,
        position: keyPositionOf(s.parsed, candidate.subPath),
        detail: ["It may be set on the machine that actually launches the server."],
        heuristic: true,
        data: { variable: varName },
      });
    }
  }

  return out;
}
