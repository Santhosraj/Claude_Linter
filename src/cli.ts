#!/usr/bin/env node
/**
 * cclint CLI.
 *
 * Exit codes:
 *   0  clean (or only findings below the failure threshold)
 *   1  lint findings at or above the threshold
 *   2  the tool itself failed
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pc from "picocolors";

import { analyze } from "./analyze.js";
import { confidenceBreakdown, MERGE_RULES } from "./model/merge-semantics.js";
import { LAYER_LABEL } from "./model/types.js";
import { relative } from "./discovery/layers.js";
import {
  renderBudget,
  renderDiagnostics,
  renderExplain,
  renderExplainList,
} from "./report/text.js";
import { toSarif } from "./report/sarif.js";
import { selectKeys } from "./resolve/settings.js";

/**
 * Read from package.json rather than hardcoded, because a hardcoded copy rots
 * silently and this one had: `npm version 0.2.0` left it at "0.1.0", so the
 * built package reported the previous release from both `--version` and — worse
 * — from every SARIF report, where the tool version is what GitHub code scanning
 * uses to track a finding's history across runs.
 *
 * `../package.json` resolves correctly from both layouts: `src/cli.ts` sits one
 * level below the repo root, and the built `dist/cli.js` one level below the
 * package root. `files: ["dist"]` means the manifest is always shipped alongside.
 */
const VERSION = ((): string => {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: string };
    if (typeof version === "string" && version.length > 0) return version;
  } catch {
    // Fall through: never let `--version` crash the tool.
  }
  // Deliberately not a plausible-looking number. A wrong version that reads as
  // real is worse than one that announces it could not be determined.
  return "unknown";
})();

const HELP = `
${pc.bold("cclint")} — lint CLAUDE.md, hooks, and MCP config

${pc.bold("Usage")}
  cclint [options]                 lint the project
  cclint explain <key>             show how a settings key resolves across layers
  cclint explain                   list the settings keys available to explain
  cclint budget                    context-budget report only
  cclint doctor                    show discovered layers and merge-rule confidence

${pc.bold("Options")}
  --format <text|json|sarif>   output format (default: text)
  --strict                     include heuristic (info) findings
  --offline                    never call the token-counting API; estimate instead
  --model <id>                 model id for token counting (default: claude-opus-5)
  --context-window <n>         override the context window used for percentages
  --cwd <dir>                  directory to lint (default: cwd)
  --home <dir>                 override the home directory used to find user config
  --project-root <dir>         force the project root instead of detecting it
  --no-budget                  skip the token pass
  --fail-on <error|warning>    exit 1 at this severity or above (default: error)
  --version, --help

${pc.bold("Semantic pass")} ${pc.dim("(opt-in; everything above is offline and free)")}
  --semantic                   adjudicate candidate rule conflicts with a model
  --semantic-model <id>        default: claude-opus-5 (anthropic)
  --semantic-provider <name>   anthropic (default) | gemini | ollama | openrouter | groq
  --semantic-base-url <url>    any other OpenAI-compatible /chat/completions host
  --semantic-max-pairs <n>     cap adjudications per run (default: 40)
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      format: { type: "string", default: "text" },
      strict: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      model: { type: "string" },
      "context-window": { type: "string" },
      cwd: { type: "string" },
      home: { type: "string" },
      "project-root": { type: "string" },
      // node:util parseArgs has no `--no-x` negation, so the opt-out is an
      // explicit flag rather than a negated boolean.
      "no-budget": { type: "boolean", default: false },
      semantic: { type: "boolean", default: false },
      "semantic-model": { type: "string" },
      "semantic-provider": { type: "string" },
      "semantic-base-url": { type: "string" },
      "semantic-max-pairs": { type: "string" },
      "fail-on": { type: "string", default: "error" },
      version: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // ---- argument validation -------------------------------------------------
  //
  // All of this exists because of one real failure: an unquoted Windows path
  // containing spaces. The shell split it, `--cwd` silently received a
  // truncated directory that did not exist, the leftover fragments became
  // ignored positionals, and discovery cheerfully walked up from the bad path
  // until it found an unrelated `.git` several levels above. The report that
  // came out was internally consistent and completely wrong — the worst kind of
  // output. Refusing bad input is the fix.
  const argError = validateArgs(positionals, values);
  if (argError) {
    process.stderr.write(argError);
    return 2;
  }

  const command = positionals[0] ?? "lint";
  const contextWindow = values["context-window"]
    ? Number(values["context-window"])
    : undefined;

  if (contextWindow !== undefined && !Number.isFinite(contextWindow)) {
    process.stderr.write(pc.red("--context-window must be a number\n"));
    return 2;
  }

  const result = await analyze({
    cwd: values.cwd,
    home: values.home,
    projectRoot: values["project-root"],
    offline: values.offline,
    model: values.model,
    contextWindow,
    strict: values.strict,
    semantic: values.semantic === true && command !== "explain" && command !== "doctor",
    semanticModel: values["semantic-model"],
    semanticProvider: values["semantic-provider"],
    semanticBaseUrl: values["semantic-base-url"],
    semanticMaxPairs: values["semantic-max-pairs"]
      ? Number(values["semantic-max-pairs"])
      : undefined,
    skipBudget: values["no-budget"] === true || command === "explain" || command === "doctor",
  });

  const root = result.context.discovery.projectRoot;

  // ---- explain -------------------------------------------------------------
  if (command === "explain") {
    const query = positionals[1];
    const explainContext = {
      all: result.context.keys,
      // A file Claude Code throws away is the reason a key can be in your
      // settings and absent from this output. Surfaced on every explain.
      discarded: result.context.resolution.sources
        .filter((s) => s.value === undefined)
        .map((s) => ({
          file: s.file,
          reason:
            s.parseErrors[0]?.message ??
            "top-level value is not a JSON object, so it contributes nothing",
        })),
    };

    // No key lists what is available rather than erroring. The set is
    // per-project and matched by prefix, so there is otherwise no way to
    // discover it short of reading the source.
    if (!query) {
      if (values.format === "json") {
        process.stdout.write(`${JSON.stringify(explainContext, null, 2)}\n`);
      } else {
        process.stdout.write(`${renderExplainList(root, explainContext)}\n`);
      }
      return 0;
    }

    const keys = selectKeys(result.context.keys, query);
    if (values.format === "json") {
      // Stays an array so `| jq length` remains the way to assert presence in
      // CI — the exit code deliberately does not distinguish a miss, because a
      // query with no results is not a tool failure.
      process.stdout.write(`${JSON.stringify(keys, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderExplain(keys, root, query, explainContext)}\n`);
    }
    return 0;
  }

  // ---- doctor --------------------------------------------------------------
  if (command === "doctor") {
    process.stdout.write(`${renderDoctor(result, root)}\n`);
    return 0;
  }

  // ---- budget --------------------------------------------------------------
  if (command === "budget") {
    if (!result.budget) {
      process.stderr.write(pc.red("budget pass was skipped\n"));
      return 2;
    }
    if (values.format === "json") {
      process.stdout.write(`${JSON.stringify(result.budget, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderBudget(result.budget, root)}\n`);
    }
    return 0;
  }

  // ---- lint ----------------------------------------------------------------
  if (values.format === "sarif") {
    process.stdout.write(`${toSarif(result.diagnostics, root, VERSION)}\n`);
  } else if (values.format === "json") {
    process.stdout.write(
      `${JSON.stringify({ diagnostics: result.diagnostics, counts: result.counts, budget: result.budget }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${renderDiagnostics(result.diagnostics, root, result.counts)}\n`);
    if (result.budget) {
      process.stdout.write(`\n${renderBudget(result.budget, root)}\n`);
    }
    if (!values.strict) {
      process.stdout.write(
        `\n${pc.dim("Heuristic checks are off by default. Run with --strict to include them.")}\n`,
      );
    }
    if (result.semantic) {
      const s = result.semantic;
      process.stdout.write(
        `${pc.dim(
          `Semantic pass: ${s.candidatePairs} candidate pair(s), ${s.adjudicated} judged by ${s.model}, ${s.cacheHits} from cache` +
            (s.unexamined ? `, ${s.unexamined} NOT examined (stopped early).` : "."),
        )}\n`,
      );
      if (s.unavailableReason) {
        process.stdout.write(`${pc.yellow(`! ${s.unavailableReason}`)}\n`);
      }
    }
  }

  const failOn = values["fail-on"] === "warning" ? "warning" : "error";
  const failing =
    failOn === "warning"
      ? result.counts.error + result.counts.warning
      : result.counts.error;
  return failing > 0 ? 1 : 0;
}

const COMMANDS = new Set(["lint", "explain", "budget", "doctor"]);

/** True when `root` is a strict ancestor of `start`. */
function relativeIsAbove(root: string, start: string): boolean {
  const r = resolve(root);
  const s = resolve(start);
  return s !== r && s.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Directory-valued flags. A bad value here poisons the whole run silently. */
const DIR_FLAGS = ["cwd", "home", "project-root"] as const;

/**
 * Reject malformed invocations up front, and — critically — say when the cause
 * looks like an unquoted path.
 */
function validateArgs(
  positionals: string[],
  values: Record<string, unknown>,
): string | undefined {
  const first = positionals[0];

  if (first !== undefined && !COMMANDS.has(first)) {
    return (
      pc.red(`Unknown command "${first}".\n`) +
      pc.dim(`  Expected one of: ${[...COMMANDS].join(", ")}\n`) +
      quotingHint(positionals)
    );
  }

  const extra = positionals.slice(1);
  const allowed = first === "explain" ? 1 : 0;
  if (extra.length > allowed) {
    return (
      pc.red(`Unexpected argument${extra.length - allowed === 1 ? "" : "s"}: `) +
      pc.red(extra.slice(allowed).map((a) => `"${a}"`).join(", ")) +
      "\n" +
      quotingHint(positionals)
    );
  }

  for (const flag of DIR_FLAGS) {
    const value = values[flag];
    if (typeof value !== "string") continue;
    if (!existsSync(value)) {
      return (
        pc.red(`--${flag} does not exist: ${value}\n`) +
        quotingHint(positionals, value)
      );
    }
    if (!statSync(value).isDirectory()) {
      return pc.red(`--${flag} is not a directory: ${value}\n`);
    }
  }

  return undefined;
}

/**
 * The single most likely cause of a bad path on Windows is a space that was
 * never quoted, which the shell turns into extra bare arguments. Saying so
 * beats making the user work it out.
 */
function quotingHint(_positionals: string[], _badValue?: string): string {
  // Deliberately unconditional. An earlier version only showed this when a
  // stray argument "looked like" a path, and promptly missed the real case:
  // the shell had already eaten the separators, so the fragment left behind
  // ("copytest-api") looked like nothing in particular. Whenever we reject
  // stray arguments or a missing directory, quoting is the overwhelmingly
  // likely cause — a redundant hint costs a line, a missing one costs an hour.
  return (
    pc.yellow("\n  Does the path contain spaces? Wrap it in quotes:\n") +
    pc.dim('    cclint doctor --cwd "D:\\path with spaces\\project"\n') +
    pc.dim(
      "  Without quotes the shell splits the path, so --cwd receives only the\n" +
        "  first fragment and the rest arrive as separate arguments.\n",
    )
  );
}

function renderDoctor(
  result: Awaited<ReturnType<typeof analyze>>,
  root: string,
): string {
  const lines: string[] = [];
  const d = result.context.discovery;

  const prov = d.rootProvenance;
  const why: Record<typeof prov.source, string> = {
    forced: "forced via --project-root",
    strong: `found ${prov.marker ?? "a marker"} here`,
    weak: `nearest ${prov.marker ?? "config file"} (no .git or .claude found)`,
    fallback: "no marker found — using the starting directory",
  };

  lines.push(pc.bold("Discovered layers"));
  lines.push(`  project root: ${d.projectRoot}`);
  lines.push(pc.dim(`                ${why[prov.source]}`));

  // The root can legitimately sit above where you pointed — but if the
  // directory you pointed at has its own CLAUDE.md, that file is being treated
  // as on-demand subtree memory rather than always-loaded project memory, and
  // the per-turn budget will read as ~0. Say so rather than let the number
  // quietly mislead.
  if (relativeIsAbove(d.projectRoot, d.startedFrom)) {
    lines.push("");
    lines.push(pc.yellow(`  ! The root is above the directory you pointed at.`));
    lines.push(pc.dim(`      you pointed at: ${d.startedFrom}`));
    lines.push(
      pc.dim(
        "      Config there is treated as subtree memory, not project memory.\n" +
          `      To lint that directory alone: --project-root "${d.startedFrom}"`,
      ),
    );
  }
  lines.push("");

  lines.push(pc.bold("  settings"));
  if (d.settings.length === 0) lines.push(pc.dim("    (none found)"));
  for (const s of d.settings) {
    lines.push(`    ${LAYER_LABEL[s.layer].padEnd(18)} ${relative(root, s.file)}`);
  }

  lines.push("");
  lines.push(pc.bold("  memory"));
  if (d.memory.length === 0) lines.push(pc.dim("    (none found)"));
  for (const m of d.memory) {
    lines.push(`    ${m.layer.padEnd(18)} ${relative(root, m.file)}`);
  }

  lines.push("");
  lines.push(pc.bold("  mcp"));
  if (d.mcp.length === 0) lines.push(pc.dim("    (none found)"));
  for (const m of d.mcp) {
    lines.push(`    ${LAYER_LABEL[m.layer].padEnd(18)} ${relative(root, m.file)}`);
  }

  const breakdown = confidenceBreakdown();
  const total = MERGE_RULES.length;
  lines.push("");
  lines.push(pc.bold("Merge-rule confidence"));
  lines.push(
    pc.dim("  How much of our model of Claude Code's merge behaviour is actually proven."),
  );
  lines.push(
    `  ${pc.green("conformance")}  ${breakdown.conformance}/${total}  ${pc.dim("proven against the real binary")}`,
  );
  lines.push(
    `  ${pc.yellow("documented")}   ${breakdown.documented}/${total}  ${pc.dim("stated in docs, not yet pinned by a fixture")}`,
  );
  lines.push(
    `  ${pc.red("assumed")}      ${breakdown.assumed}/${total}  ${pc.dim("our best guess — findings that depend on these are demoted")}`,
  );

  if (breakdown.conformance < total) {
    lines.push("");
    lines.push(
      pc.dim("  Run `npm run conformance:record` to promote rules by testing them"),
    );
    lines.push(pc.dim("  against the installed Claude Code binary."));
  }

  return lines.join("\n");
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${pc.red("cclint failed:")} ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
