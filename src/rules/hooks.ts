/**
 * Hook static checks.
 *
 * Every finding here is anchored to the settings file that actually declares
 * the hook, not to the merged view — telling someone "your PreToolUse hook is
 * broken" without naming which of four files it came from is the exact problem
 * this tool exists to solve.
 */

import { delimiter, isAbsolute, join, resolve } from "node:path";

import { isFile, relative } from "../discovery/layers.js";
import { keyPositionOf } from "../parse/json.js";
import { isPlainObject } from "../resolve/settings.js";
import type { Diagnostic } from "../model/types.js";
import { SEVERITY, type RuleContext } from "./context.js";

/**
 * Hook events Claude Code dispatches. An unknown event never fires.
 *
 * SOURCE OF TRUTH: `claude doctor` prints the full valid-event list whenever it
 * rejects an unknown one. That is where this list comes from — do not hand-edit
 * it from memory or documentation.
 *
 * To refresh after a Claude Code update:
 *   1. put a bogus event in a settings.json
 *   2. run `claude doctor` in that directory
 *   3. copy the "Valid events:" list verbatim
 *
 * This matters more than it looks. An earlier version of this list had 9 events
 * against the real 31, so cclint reported 22 perfectly valid hook events as
 * "this hook will never fire" — telling users to delete working config, which is
 * the single most damaging thing this tool could do. The conformance fixtures
 * `sample-project` and `settings-malformed-hooks` now pin it against the binary,
 * via their recorded `Valid events:` list.
 *
 * The version this was last checked against is NOT repeated here: those
 * recordings carry it, `npm run conformance:record` keeps them current, and a
 * hand-written copy in a comment only rots. It had already drifted — this block
 * claimed 2.1.224 while the recordings had moved on, and named a fixture
 * (`settings-unknown-hook-event`) that does not exist.
 */
export const KNOWN_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "DirectoryAdded",
  "MessageDisplay",
]);

/**
 * Built-in tool names, used to sanity-check plain-string hook matchers.
 *
 * UNLIKE `KNOWN_EVENTS`, THIS LIST HAS NO ORACLE. Probing the binary showed
 * that Claude Code does not validate tool names at all: a hook matcher naming a
 * tool that does not exist, and a `permissions.allow` entry naming one, both
 * pass `claude doctor` without a word. An unknown matcher simply never matches.
 *
 * The real tool surface also shifts underneath us — it varies by Claude Code
 * version, by enabled plugins, and by connected MCP servers, each of which can
 * introduce names we cannot know about.
 *
 * Consequence: any finding based on this list is a guess, and the failure mode
 * is telling someone their working hook is broken. So `hooks/unknown-matcher`
 * is deliberately `info`-tier and off by default — see the severity policy in
 * rules/context.ts. Do not promote it without an oracle.
 */
export const KNOWN_TOOLS = new Set([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "Edit",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "NotebookEdit",
  "Read",
  "Skill",
  "SlashCommand",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
]);

export function hookRules(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const source of ctx.resolution.sources) {
    if (!source.value) continue;
    const hooks = source.value["hooks"];
    if (hooks === undefined) continue;

    const parsed = ctx.parsed.get(source.file);
    const at = (path: string) => (parsed ? keyPositionOf(parsed, path) : undefined);

    if (!isPlainObject(hooks)) {
      out.push({
        ruleId: "hooks/malformed",
        severity: SEVERITY.deterministic,
        message: "`hooks` must be an object keyed by event name.",
        file: source.file,
        position: at("hooks"),
      });
      continue;
    }

    for (const [event, matchers] of Object.entries(hooks)) {
      const eventPath = `hooks.${event}`;

      if (!KNOWN_EVENTS.has(event)) {
        out.push({
          ruleId: "hooks/unknown-event",
          severity: SEVERITY.deterministic,
          message: `Unknown hook event "${event}" — this hook will never fire.`,
          file: source.file,
          position: at(eventPath),
          detail: [`Known events: ${[...KNOWN_EVENTS].join(", ")}`],
          data: { event },
        });
        continue;
      }

      if (!Array.isArray(matchers)) {
        out.push({
          ruleId: "hooks/malformed",
          severity: SEVERITY.deterministic,
          message: `hooks.${event} must be an array of matcher groups.`,
          file: source.file,
          position: at(eventPath),
        });
        continue;
      }

      matchers.forEach((group, i) => {
        const groupPath = `${eventPath}.${i}`;
        if (!isPlainObject(group)) {
          out.push({
            ruleId: "hooks/malformed",
            severity: SEVERITY.deterministic,
            message: `hooks.${event}[${i}] must be an object.`,
            file: source.file,
            position: at(groupPath),
          });
          return;
        }

        checkMatcher(group["matcher"], {
          out,
          file: source.file,
          position: at(`${groupPath}.matcher`),
          event,
          index: i,
        });

        const inner = group["hooks"];
        if (!Array.isArray(inner)) {
          out.push({
            ruleId: "hooks/malformed",
            severity: SEVERITY.deterministic,
            message: `hooks.${event}[${i}].hooks must be an array.`,
            file: source.file,
            position: at(`${groupPath}.hooks`),
          });
          return;
        }

        inner.forEach((hook, j) => {
          const hookPath = `${groupPath}.hooks.${j}`;
          if (!isPlainObject(hook)) {
            out.push({
              ruleId: "hooks/malformed",
              severity: SEVERITY.deterministic,
              message: `hooks.${event}[${i}].hooks[${j}] must be an object.`,
              file: source.file,
              position: at(hookPath),
            });
            return;
          }

          if (hook["type"] !== "command") {
            out.push({
              ruleId: "hooks/malformed",
              severity: SEVERITY.deterministic,
              message: `Hook type must be "command" (got ${JSON.stringify(hook["type"])}).`,
              file: source.file,
              position: at(`${hookPath}.type`),
              // Pointer shape matches `claude doctor` verbatim
              // (`hooks.PreToolUse.0.hooks.0.type`), so the conformance suite
              // can assert agreement per-pointer rather than per-file.
              data: { pointer: `${hookPath}.type` },
            });
          }

          const command = hook["command"];
          if (typeof command !== "string" || command.trim().length === 0) {
            out.push({
              ruleId: "hooks/malformed",
              severity: SEVERITY.deterministic,
              message: "Hook is missing a non-empty `command`.",
              file: source.file,
              position: at(hookPath),
              data: { pointer: `${hookPath}.command` },
            });
            return;
          }

          checkCommandTarget(command, {
            out,
            ctx,
            file: source.file,
            position: at(`${hookPath}.command`),
          });

          const timeout = hook["timeout"];
          if (timeout !== undefined && (typeof timeout !== "number" || timeout <= 0)) {
            out.push({
              ruleId: "hooks/malformed",
              severity: SEVERITY.deterministic,
              message: "Hook `timeout` must be a positive number of seconds.",
              file: source.file,
              position: at(`${hookPath}.timeout`),
            });
          }
        });
      });
    }
  }

  return out;
}

interface MatcherCtx {
  out: Diagnostic[];
  file: string;
  position: ReturnType<typeof keyPositionOf>;
  event: string;
  index: number;
}

function checkMatcher(matcher: unknown, m: MatcherCtx): void {
  if (matcher === undefined || matcher === "" || matcher === "*") return;

  if (typeof matcher !== "string") {
    m.out.push({
      ruleId: "hooks/malformed",
      severity: SEVERITY.deterministic,
      message: "Hook `matcher` must be a string.",
      file: m.file,
      position: m.position,
    });
    return;
  }

  // Matchers may be regexes ("Edit|Write"). Only flag a bare identifier that
  // clearly names a tool and clearly is not one — anything with regex syntax
  // is out of scope, because guessing at regex intent produces false positives.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(matcher)) return;
  if (KNOWN_TOOLS.has(matcher)) return;
  if (matcher.startsWith("mcp__")) return; // MCP tool, validated elsewhere

  m.out.push({
    ruleId: "hooks/unknown-matcher",
    // Info-tier, not a warning: we have no way to verify this. See the comment
    // on KNOWN_TOOLS. Claude Code accepts any matcher string silently, and
    // plugins and MCP servers add tool names we cannot enumerate.
    severity: SEVERITY.heuristic,
    message: `Hook matcher "${matcher}" does not name a tool known to this version of cclint.`,
    file: m.file,
    position: m.position,
    detail: [
      "This may be fine: plugins and MCP servers add tools cclint cannot enumerate,",
      "and Claude Code itself does not validate matcher names.",
      "If it is genuinely a typo the hook will simply never fire.",
    ],
    heuristic: true,
    data: { matcher },
  });
}

interface CommandCtx {
  out: Diagnostic[];
  ctx: RuleContext;
  file: string;
  position: ReturnType<typeof keyPositionOf>;
}

/**
 * Resolve the executable a hook command will actually run.
 *
 * This is environmental, not deterministic: a binary missing on the linting
 * machine may exist on the machine that runs the hook. So a missing target is a
 * warning, never an error — with one exception, an explicit
 * $CLAUDE_PROJECT_DIR-relative path, which is repo-relative and therefore
 * genuinely checkable.
 */
function checkCommandTarget(command: string, c: CommandCtx): void {
  const first = firstToken(command);
  if (!first) return;

  const projectDir = c.ctx.discovery.projectRoot;

  if (first.includes("$CLAUDE_PROJECT_DIR") || first.includes("${CLAUDE_PROJECT_DIR}")) {
    const rel = first
      .replace("${CLAUDE_PROJECT_DIR}", "")
      .replace("$CLAUDE_PROJECT_DIR", "")
      .replace(/^[/\\]+/, "");
    const target = join(projectDir, rel);
    if (!isFile(target)) {
      c.out.push({
        ruleId: "hooks/dead-command",
        severity: SEVERITY.deterministic,
        message: `Hook script not found: ${relative(projectDir, target)}`,
        file: c.file,
        position: c.position,
        detail: [`Resolved from: ${first}`],
        data: { target },
      });
    }
    return;
  }

  // Relative or absolute filesystem path.
  if (first.startsWith(".") || first.includes("/") || first.includes("\\")) {
    const target = isAbsolute(first) ? first : resolve(projectDir, first);
    if (!isFile(target)) {
      c.out.push({
        ruleId: "hooks/dead-command",
        severity: SEVERITY.environmental,
        message: `Hook command path does not exist: ${first}`,
        file: c.file,
        position: c.position,
        detail: ["Checked relative to the project root."],
        heuristic: true,
        data: { target },
      });
    }
    return;
  }

  // Bare binary name — look it up on PATH.
  if (!onPath(first)) {
    c.out.push({
      ruleId: "hooks/command-not-on-path",
      severity: SEVERITY.environmental,
      message: `Hook command "${first}" was not found on PATH.`,
      file: c.file,
      position: c.position,
      detail: ["This may still work on the machine that runs the hook."],
      heuristic: true,
      data: { binary: first },
    });
  }
}

/** First word of a shell command, skipping env-var assignments like FOO=1. */
export function firstToken(command: string): string | undefined {
  const parts = command.trim().split(/\s+/);
  for (const part of parts) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) continue;
    return part.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const PATH_CACHE = new Map<string, boolean>();

export function onPath(binary: string): boolean {
  const cached = PATH_CACHE.get(binary);
  if (cached !== undefined) return cached;

  const dirs = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  let found = false;
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      if (isFile(join(dir, binary + ext)) || isFile(join(dir, binary + ext.toLowerCase()))) {
        found = true;
        break outer;
      }
    }
  }
  PATH_CACHE.set(binary, found);
  return found;
}
