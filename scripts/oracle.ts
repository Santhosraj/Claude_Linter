/**
 * The oracle: ask the real Claude Code binary what it thinks of a fixture.
 *
 * `claude mcp list` is the ideal oracle for MCP config — it resolves the same
 * layered config Claude Code uses at runtime, reports which servers it accepted
 * and which it skipped and why, and it does all of that WITHOUT making an API
 * call. That means the conformance corpus is free to record and safe to run in
 * CI on every Claude Code release.
 *
 * Everything here is deliberately tolerant: the binary's human-readable output
 * is not a stable contract, so we parse defensively and fail loudly rather than
 * silently recording an empty expectation (which would make the test vacuous —
 * the worst possible outcome for a correctness harness).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface OracleServer {
  status: "ok" | "skipped";
  reason?: string;
}

export interface OracleResult {
  claudeVersion: string;
  servers: Record<string, OracleServer>;
}

/**
 * Result of the hook oracle: which config layers' hooks ACTUALLY EXECUTED,
 * in execution order, for a given event.
 *
 * This is stronger evidence than parsing a debug log. It observes the behaviour
 * the linter actually claims ("hooks from every layer fire") rather than an
 * implementation detail that could be reformatted at any release.
 */
export interface HookOracleResult {
  claudeVersion: string;
  event: string;
  /** Layer markers in execution order, e.g. ["user", "projectShared"]. */
  executed: string[];
}

/**
 * Result of the `claude doctor` oracle.
 *
 * `claude doctor` reads the settings files in a directory WITHOUT a trust
 * prompt and without an API call, then reports what it rejected. It is a far
 * richer oracle than `claude mcp list`: it validates hook events, JSON syntax,
 * and MCP entries in one pass — and when it rejects an unknown hook event it
 * prints the complete list of valid ones, which is the only trustworthy source
 * for that list.
 *
 * Adopting it caught three live bugs at once: a hand-written event list with 9
 * entries against the real 31, an MCP transport list missing `ws` / `sdk` /
 * `streamable-http`, and — worst — silent tolerance of JSON comments that
 * Claude Code rejects, discarding the entire file.
 */
export interface DoctorOracleResult {
  claudeVersion: string;
  /** Every hook event the binary accepts, verbatim from its own output. */
  validHookEvents: string[];
  /** Every settings complaint the binary raised. */
  complaints: DoctorComplaint[];
}

export interface DoctorComplaint {
  /** Project-relative where possible, so recordings are machine-independent. */
  file: string;
  /** The config pointer the binary named, e.g. `hooks.OnFileSave`. */
  pointer?: string;
  message: string;
  kind:
    | "unknown-hook-event"
    | "malformed-json"
    | "mcp-skipped"
    | "hook-schema"
    | "other";
}

const ANSI = /\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

export function claudeVersion(): string {
  const raw = execFileSync("claude", ["--version"], { encoding: "utf8" });
  return stripAnsi(raw).trim().split(/\s+/)[0] ?? "unknown";
}

/**
 * Environment for every oracle run.
 *
 * Stripping the Anthropic credentials is the load-bearing part: `...process.env`
 * would otherwise forward a real ANTHROPIC_API_KEY from the developer's shell,
 * turning a "free" recording into a billed request without anyone noticing.
 */
export function sandboxEnv(fakeHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Closed port: even a credentialed run fails at connect, never at the API.
    ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
  };
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AUTH_TOKEN"];
  return env;
}

export function runMcpList(projectDir: string, fakeHome: string): string {
  const raw = execFileSync("claude", ["mcp", "list"], {
    cwd: projectDir,
    encoding: "utf8",
    env: sandboxEnv(fakeHome),
    // Health checks can be slow; the binary also exits non-zero when it emits
    // warnings, which is not a harness failure.
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return stripAnsi(raw);
}

/**
 * Parse `claude mcp list` output.
 *
 * Accepted servers appear as `name: <command or url> - <health>`.
 * Skipped servers appear in the diagnostics block as
 *   `[Warning] [name] mcpServers.name: Skipped — <reason>`
 */
export function parseMcpList(output: string): Record<string, OracleServer> {
  const servers: Record<string, OracleServer> = {};

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // Diagnostics first: a server named here was skipped, and that verdict
    // must win over any earlier "looks fine" listing line.
    const diag = /\[(?:Warning|Error)\]\s*\[([^\]]+)\]\s*(.*)$/.exec(line);
    if (diag?.[1]) {
      const name = diag[1];
      const detail = (diag[2] ?? "").trim();
      if (/skipped/i.test(detail) || /invalid/i.test(detail)) {
        servers[name] = { status: "skipped", reason: normalizeReason(detail) };
      }
      continue;
    }

    // Listing lines. Skip the tree-drawing and header lines.
    if (/^[├└│]/.test(line)) continue;
    const listed = /^([A-Za-z0-9_.-]+):\s+(.*?)\s+-\s+/.exec(line);
    if (listed?.[1] && !servers[listed[1]]) {
      servers[listed[1]] = { status: "ok" };
    }
  }

  return servers;
}

function normalizeReason(detail: string): string {
  // Drop the `mcpServers.<name>: ` prefix and collapse whitespace so recorded
  // reasons stay readable and diff cleanly.
  return detail
    .replace(/^mcpServers\.[A-Za-z0-9_.-]+:\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hook oracle — free, deterministic, and it makes no API call.
 *
 * Each layer's fixture hook appends its layer name to `.hooklog`. A
 * `UserPromptSubmit` hook fires on every prompt with no model decision involved
 * — unlike `PreToolUse`, which only fires if the model happens to choose that
 * tool and would make the fixture flaky.
 *
 * NO API CALL IS MADE, and that is enforced three ways rather than assumed:
 *
 *   1. The sandboxed fake home holds no credentials, so the run stops at
 *      "Not logged in" after the hooks have already fired.
 *   2. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are stripped from the child
 *      environment. Inheriting a real key from the parent shell is the one way
 *      this could silently start costing money.
 *   3. ANTHROPIC_BASE_URL points at a closed local port, so even a credentialed
 *      run fails at connect rather than reaching the API.
 *
 * An earlier version had the hooks `exit 2` to block the prompt. That worked but
 * tore the process down before every hook shell had flushed, which produced
 * intermittently missing layers — the stability check below caught it.
 */
export function recordHookOracle(
  projectDir: string,
  fakeHome: string,
  event: string,
  repeats = 3,
): HookOracleResult {
  const runs: string[][] = [];
  for (let i = 0; i < repeats; i++) {
    runs.push(runHookProbe(projectDir, fakeHome));
  }

  // Hook shells run concurrently and append to the log independently, so a
  // naive single read can catch the file mid-write and silently under-report a
  // layer. Recording that would bake a FALSE expectation into the suite — the
  // test would then "prove" a layer does not fire when it does. Requiring
  // several identical runs turns that race into a loud failure instead.
  const signatures = runs.map((r) => [...r].sort().join(","));
  const stable = signatures.every((s) => s === signatures[0]);
  if (!stable) {
    throw new Error(
      `Hook oracle was not stable across ${repeats} runs in ${projectDir}.\n` +
        runs.map((r, i) => `  run ${i + 1}: [${r.join(", ")}]`).join("\n") +
        "\nRefusing to record a flaky expectation.",
    );
  }

  return { claudeVersion: claudeVersion(), event, executed: runs[0]! };
}

function runHookProbe(projectDir: string, fakeHome: string): string[] {
  const log = join(projectDir, ".hooklog");
  rmSync(log, { force: true });

  try {
    execFileSync("claude", ["-p", "conformance-probe"], {
      cwd: projectDir,
      encoding: "utf8",
      env: sandboxEnv(fakeHome),
      timeout: 120_000,
      // The run exits non-zero once it cannot authenticate. That is the
      // expected outcome here, not a harness failure.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Swallow: we read the verdict from the log, not from the exit code.
  }

  const executed = readLogWhenSettled(log);
  rmSync(log, { force: true });

  if (executed.length === 0) {
    throw new Error(
      `Hook oracle produced no .hooklog entries in ${projectDir}. Refusing to ` +
        "record an empty expectation — it would make the conformance test pass " +
        "vacuously.\nCheck that the fixture's hooks use a shell-portable command " +
        "and that $CLAUDE_PROJECT_DIR resolves.",
    );
  }
  return executed;
}

/** Poll until the log stops growing, so we never read a half-written file. */
function readLogWhenSettled(log: string, quietMs = 400, timeoutMs = 8_000): string[] {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stableSince = 0;

  for (;;) {
    const current = existsSync(log) ? readFileSync(log, "utf8") : "";
    if (current === previous && current.length > 0) {
      if (stableSince === 0) stableSince = Date.now();
      else if (Date.now() - stableSince >= quietMs) break;
    } else {
      previous = current;
      stableSince = 0;
    }
    if (Date.now() > deadline) break;
    sleepSync(50);
  }

  return previous
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Synchronous sleep — this is a recording script, not a hot path. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `claude doctor` in the fixture and capture what it rejected.
 *
 * Output shape (after ANSI stripping):
 *
 *   Invalid settings
 *   - <abs path> › hooks.OnFileSave: Unknown hook event "OnFileSave" was ignored. Valid events: A, B, C
 *   - <abs path>: Invalid or malformed JSON
 *   - <abs path> › mcpServers.x: Skipped — ...
 *
 * The section ends at the first blank line, so unrelated sections (Remote
 * Control, warnings about PATH) are never mistaken for settings complaints.
 */
export function recordDoctorOracle(
  projectDir: string,
  fakeHome: string,
): DoctorOracleResult {
  let raw: string;
  try {
    raw = execFileSync("claude", ["doctor"], {
      cwd: projectDir,
      encoding: "utf8",
      env: sandboxEnv(fakeHome),
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // doctor exits non-zero when it finds warnings; the report is still on stdout.
    const e = error as { stdout?: string };
    raw = e.stdout ?? "";
  }

  const output = stripAnsi(raw);
  const complaints = parseDoctorComplaints(output, projectDir);
  const validHookEvents = parseValidHookEvents(output);

  if (validHookEvents.length === 0) {
    throw new Error(
      "`claude doctor` did not print a valid-hook-event list. The fixture must " +
        "contain a settings.json with a deliberately unknown hook event — that " +
        "is what makes the binary enumerate the valid ones.\n\n" +
        `Raw output:\n${output.slice(0, 1200)}`,
    );
  }

  return { claudeVersion: claudeVersion(), validHookEvents, complaints };
}

export function parseValidHookEvents(output: string): string[] {
  const match = /Valid events:\s*([^\n]+)/.exec(output);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z]+$/.test(s));
}

export function parseDoctorComplaints(
  output: string,
  projectDir: string,
): DoctorComplaint[] {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "Invalid settings");
  if (start === -1) return [];

  const out: DoctorComplaint[] = [];

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break; // section ends at the first blank line
    if (!line.trimStart().startsWith("- ")) continue; // e.g. "Suggested fix:" detail

    const body = line.trimStart().slice(2);

    // `<path> › <pointer>: <message>` or `<path>: <message>`
    const withPointer = /^(.*?)\s*›\s*([^:]+):\s*(.*)$/.exec(body);

    let file: string;
    let pointer: string | undefined;
    let message: string;

    if (withPointer?.[1]) {
      file = withPointer[1];
      pointer = withPointer[2]?.trim();
      message = (withPointer[3] ?? "").trim();
    } else {
      // Split on the first ": " AFTER index 2, so a Windows drive letter is
      // not mistaken for the separator. A naive non-greedy `^(.*?):` split
      // `D:\...\settings.local.json: Invalid or malformed JSON` into a file
      // named "D" and swallowed the real path into the message.
      const sep = body.indexOf(": ", 2);
      if (sep === -1) continue;
      file = body.slice(0, sep);
      message = body.slice(sep + 2).trim();
    }

    out.push({
      file: toRelative(projectDir, file.trim()),
      ...(pointer ? { pointer } : {}),
      message,
      kind: classifyComplaint(message, pointer),
    });
  }

  return out;
}

function classifyComplaint(
  message: string,
  pointer: string | undefined,
): DoctorComplaint["kind"] {
  if (/Unknown hook event/i.test(message)) return "unknown-hook-event";
  if (/Invalid or malformed JSON/i.test(message)) return "malformed-json";
  if (/^Skipped/i.test(message)) return "mcp-skipped";
  // Anything else pointing into `hooks.` is a schema violation on an individual
  // hook entry, e.g. `hooks.PreToolUse.0.hooks.0.command: Expected string`.
  if (pointer?.startsWith("hooks.")) return "hook-schema";
  return "other";
}

/** Recordings must not embed absolute paths from the recorder's machine. */
function toRelative(projectDir: string, file: string): string {
  const root = projectDir.split("\\").join("/");
  const f = file.split("\\").join("/");
  return f.startsWith(root) ? f.slice(root.length).replace(/^\/+/, "") : f;
}

/**
 * Result of the workspace-trust oracle.
 *
 * `claude --debug` announces, before any network call, which permission entries
 * it is dropping because the workspace has not been trusted:
 *
 *   Ignoring 2 permissions.allow entries from .claude/settings.json:
 *   this workspace has not been trusted.
 *
 * The count and the file name are the whole signal, and they are what pins the
 * gating boundaries: a fixture that also carries `deny`, `ask` and a user-level
 * `allow` proves those are NOT gated, because they are absent from the count.
 */
export interface TrustOracleResult {
  claudeVersion: string;
  /** Per-file counts of ignored `permissions.allow` entries. */
  ignoredAllow: { file: string; count: number }[];
}

export function recordTrustOracle(
  projectDir: string,
  fakeHome: string,
): TrustOracleResult {
  let raw: string;
  try {
    raw = execFileSync("claude", ["--debug", "-p", "conformance-probe"], {
      cwd: projectDir,
      encoding: "utf8",
      env: sandboxEnv(fakeHome),
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    raw = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }

  const output = stripAnsi(raw);
  const ignoredAllow = parseIgnoredAllow(output);

  if (ignoredAllow.length === 0) {
    throw new Error(
      "Trust oracle saw no `Ignoring ... permissions.allow` line. The fixture " +
        "must declare project-level allow entries AND leave the workspace " +
        "untrusted (no matching key in the fake home's .claude.json).\n\n" +
        `Raw output:\n${output.slice(0, 1000)}`,
    );
  }

  return { claudeVersion: claudeVersion(), ignoredAllow };
}

export function parseIgnoredAllow(output: string): { file: string; count: number }[] {
  const out: { file: string; count: number }[] = [];
  const re = /Ignoring (\d+) permissions\.allow (?:entry|entries) from ([^:]+):/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const count = Number(m[1]);
    const file = (m[2] ?? "").trim().split("\\").join("/");
    if (Number.isFinite(count) && file) out.push({ file, count });
  }
  return out;
}

export function recordOracle(projectDir: string, fakeHome: string): OracleResult {
  const output = runMcpList(projectDir, fakeHome);
  const servers = parseMcpList(output);

  if (Object.keys(servers).length === 0) {
    throw new Error(
      "Oracle produced no servers. Refusing to record an empty expectation — " +
        "an empty fixture would make the conformance test pass vacuously.\n\n" +
        `Raw output:\n${output}`,
    );
  }

  return { claudeVersion: claudeVersion(), servers };
}
