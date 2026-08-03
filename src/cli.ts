#!/usr/bin/env node
/**
 * cclint CLI.
 *
 * Exit codes:
 *   0  clean (or only findings below the failure threshold)
 *   1  lint findings at or above the threshold
 *   2  the tool itself failed
 */

import { parseArgs } from "node:util";
import pc from "picocolors";

import { analyze } from "./analyze.js";
import { confidenceBreakdown, MERGE_RULES } from "./model/merge-semantics.js";
import { LAYER_LABEL } from "./model/types.js";
import { relative } from "./discovery/layers.js";
import { renderBudget, renderDiagnostics, renderExplain } from "./report/text.js";
import { toSarif } from "./report/sarif.js";
import { selectKeys } from "./resolve/settings.js";

const VERSION = "0.1.0";

const HELP = `
${pc.bold("cclint")} — lint CLAUDE.md, hooks, and MCP config

${pc.bold("Usage")}
  cclint [options]                 lint the project
  cclint explain <key>             show how a settings key resolves across layers
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
  --no-budget                  skip the token pass
  --fail-on <error|warning>    exit 1 at this severity or above (default: error)
  --version, --help

${pc.bold("Semantic pass")} ${pc.dim("(opt-in; everything above is offline and free)")}
  --semantic                   adjudicate candidate rule conflicts with a model
  --semantic-model <id>        default: claude-opus-5
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
      // node:util parseArgs has no `--no-x` negation, so the opt-out is an
      // explicit flag rather than a negated boolean.
      "no-budget": { type: "boolean", default: false },
      semantic: { type: "boolean", default: false },
      "semantic-model": { type: "string" },
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
    offline: values.offline,
    model: values.model,
    contextWindow,
    strict: values.strict,
    semantic: values.semantic === true && command !== "explain" && command !== "doctor",
    semanticModel: values["semantic-model"],
    semanticMaxPairs: values["semantic-max-pairs"]
      ? Number(values["semantic-max-pairs"])
      : undefined,
    skipBudget: values["no-budget"] === true || command === "explain" || command === "doctor",
  });

  const root = result.context.discovery.projectRoot;

  // ---- explain -------------------------------------------------------------
  if (command === "explain") {
    const query = positionals[1];
    if (!query) {
      process.stderr.write(pc.red("explain requires a key, e.g. `cclint explain hooks`\n"));
      return 2;
    }
    const keys = selectKeys(result.context.keys, query);
    if (values.format === "json") {
      process.stdout.write(`${JSON.stringify(keys, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderExplain(keys, root, query)}\n`);
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
          `Semantic pass: ${s.candidatePairs} candidate pair(s), ${s.adjudicated} judged by ${s.model}, ${s.cacheHits} from cache.`,
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

function renderDoctor(
  result: Awaited<ReturnType<typeof analyze>>,
  root: string,
): string {
  const lines: string[] = [];
  const d = result.context.discovery;

  lines.push(pc.bold("Discovered layers"));
  lines.push(pc.dim(`  project root: ${d.projectRoot}`));
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
