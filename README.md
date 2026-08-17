# cclint

Lint the configuration a Claude Code project accumulates — `CLAUDE.md`, hooks,
MCP servers — for the failures that are silent until the agent starts behaving
oddly: dead references, config that a higher layer quietly overrides,
instructions that contradict each other, and context you're paying for on every
turn without realising it.

```bash
npm install -g @santhosraj/cclint@latest  # the command it installs is `cclint`

cclint                                 # the checks
cclint doctor                          # what was discovered, and why
cclint explain hooks.PreToolUse
cclint budget
```

Or run it once without installing: `npx @santhosraj/cclint doctor`.

The package is scoped; the command is not. `cclint` is what you type after
installing, and it is the name used throughout this document. The unscoped
`cclint` on npm is unavailable — the registry rejects it as too similar to an
existing `cc-lint`, and `claude-config-lint` belongs to an unrelated project.

The default run is **fully offline, free, and fast**. No API key, no network.

**Requirements:** Node 20 or newer, and nothing else.

**Running from a clone** — what to use while developing, or before a release has
landed on npm:

```bash
npm install
npx tsx src/cli.ts doctor              # the same CLI, straight from source
npx tsx src/cli.ts --cwd "D:\some project"
```

Every command below works identically either way; `npx tsx src/cli.ts` simply
replaces `cclint`. If you have both a global install and a clone, note that
`npx @santhosraj/cclint` prefers whatever is already on your machine over the
registry — so a stale global install will shadow a newer release without saying
so. `cclint --version` tells you which one you are actually running, and
`npx @santhosraj/cclint@<version>` forces the registry.

> **Quote paths containing spaces.** `--cwd "D:\my project"`, not `--cwd D:\my project`.
> Unquoted, the shell splits the path and the flag receives only the first
> fragment. `cclint` rejects that with exit 2 rather than guessing — but the
> quotes save you the round trip.

Start with `doctor`. It prints the project root, the marker that decided it, and
every config file found — so you can confirm discovery is right before trusting
any finding.

`CLAUDE_CONFIG_DIR` is honoured, as Claude Code honours it: user settings, user
memory and the `projects` trust store are all read from there instead of
`~/.claude`. Worth knowing because the store moves *inside* that directory, where
by default it sits beside it at `~/.claude.json` — and reading the wrong one makes
a trusted workspace look untrusted.

---

## Why this exists

Claude Code config is spread across four or five layers that merge by rules
nobody can hold in their head, and the merge rule **is different per key**:

| Key | Merge behaviour |
|---|---|
| `model`, `theme`, `permissions.defaultMode` | higher layer **overrides** — lower layers are dead |
| `hooks.*` | **additive** — every layer's hooks run; nothing is overridden |
| `permissions.allow` / `.deny` / `.ask` | **unioned** across layers |
| `env` | **deep-merged** per key |

Modelling this as "higher layer wins" — the obvious implementation — produces
confidently wrong output. It will tell you a user-level hook was overridden by a
project hook when in fact **both fire**, and send you deleting hooks that are
working. Getting this table right is the core of the tool; see
[`src/model/merge-semantics.ts`](src/model/merge-semantics.ts).

`CLAUDE.md` plays by entirely different rules again: every applicable file is
**concatenated** into context simultaneously. Nothing overrides anything, so two
files stating opposite things is a live conflict with nothing to resolve it, and
a project file restating a user rule is duplicated instruction burning tokens
twice.

---

## Commands

### `cclint` — the checks

Deterministic findings only, by default. `--strict` adds heuristic ones.

- **json** — comments and trailing commas. Claude Code parses settings as
  **strict** JSON: one `//` invalidates the entire file and every setting in it
  silently stops applying. cclint reports it as an error and excludes the file
  from resolution, exactly as Claude Code does.
- **hooks** — unknown events (a hook that can never fire), malformed schemas,
  scripts that don't exist, commands not on `PATH`, matchers naming no known tool
- **mcp** — malformed server entries, unknown transports, unparseable URLs,
  duplicate server names across scopes, unset `$VAR` references
- **settings** — values overridden by a higher-precedence layer, unrecognised keys
- **permissions** — entries already covered by a broader wildcard, exact
  duplicates, paths that cannot exist, and — the one people are most surprised
  by — **project-level `allow` entries that Claude Code is ignoring entirely
  because the workspace has not been trusted**. That gating is narrow and each
  boundary is pinned by a conformance fixture: only `allow`, only from a project
  layer. `deny`, `ask`, and your own user-level `allow` keep working.
- **memory** — dead `@imports`, import cycles, rules duplicated within a file or
  across two files that are both always in context, and a `claude.md` that differs
  from `CLAUDE.md` only by **case**. That last one is invisible on the machine
  that has it: Claude Code matches the name literally, so the file is memory on
  Windows and macOS and nothing at all on Linux or in CI, where the instructions
  in it silently stop applying. Both projects I first ran this against had one.
- **budget** — with `--strict`, an always-loaded context large enough to be worth
  knowing about (10k+ tokens spent before your prompt, every turn). `info`,
  because a big `CLAUDE.md` can be entirely deliberate — but a green checkmark
  above a 16,000-token floor is the tool failing to mention its own headline.

### `cclint explain <key>` — the effective-config view

The flagship output. Which layer won, which also contributed, which were
discarded:

```
hooks.PreToolUse  [hooks]
  Hooks from every layer are additive: a project hook does not replace a user
  hook for the same event — both fire.

  ✓ user               [{"matcher":"Bash", ...}]
    .claude/settings.json:13
  ✓ project            [{"matcher":"Bash", ...}]
    .claude/settings.json:11
  ✓ project (local)    [{"matcher":"Edit", ...}]
    .claude/settings.local.json:8

  All 3 layer(s) contribute; none is overridden.
```

**Which keys can you pass?** There is no fixed menu. `<key>` is a
case-insensitive **prefix match against the keys your own settings files
actually define**, so the answer is per-project. `cclint explain permissions`
shows `allow`, `deny` and `ask` together; `cclint explain e` shows everything
starting with `e`. `cclint doctor` lists the files being read.

Nested paths are dynamic and cannot be enumerated in advance — `hooks.PreToolUse`,
`env.MY_VAR` and `enabledPlugins.<plugin@marketplace>` become explain targets
only once your settings define them. So `No settings key matches "hooks.PreToolUse"`
means you have no such hook configured, not that the key is wrong.

Ask for a key you don't have and it tells you what you *do* have, rather than
leaving you guessing whether the key is wrong or the config is missing:

```
No settings key matches "permisions.deny".

  Did you mean?
    permissions.deny     .claude\settings.json:3

  10 key(s) are available. Run `cclint explain` with no key to list them, or
  `cclint doctor` to see which files were read.
```

**Discarded files are reported on every `explain`, hit or miss** — this is a
correctness fix, not a nicety. A `settings.json` holding `permissions.deny` plus
one trailing comma is thrown away wholesale, so `explain permissions.deny`
truthfully finds no such key. Saying only that reads as *"you have no deny
configured"*, when the truth is *"your deny is in the file and not in effect"* —
the single most important thing this tool can tell you. So it says:

```
  1 file(s) discarded and NOT part of the resolution below:
    .claude\settings.json — Trailing comma is not allowed here — Claude Code discards the whole file.
    Keys defined only there do not appear here, and Claude Code ignores them too.
```

A miss exits **0**, deliberately: a query with no results is not a tool failure.
To assert a key exists in CI, count the JSON instead —
`cclint explain permissions.deny --format=json | jq length`.

### `cclint budget` — what context actually costs

Artifacts are classified by how they actually reach the model, because summing
everything under `.claude/` produces a scary number that is mostly fiction:

| Class | Meaning |
|---|---|
| **always** | `CLAUDE.md` hierarchy and its `@imports` — loaded every turn |
| **advertised** | skills and subagents contribute only name + description until invoked |
| **on demand** | slash commands, skill bodies, nested `CLAUDE.md` — free until used |

Only the first two are summed into the reported per-turn floor.

Counts are **exact** via the token-counting endpoint when `ANTHROPIC_API_KEY` is
set, and offline estimates otherwise — always rendered with a `~` and the word
"estimated". We don't ship a GPT tokenizer; it's the wrong BPE for Claude.

### `cclint doctor` — how much of this is actually proven

Prints discovered layers plus the merge-rule confidence breakdown (below).

---

## Accuracy

A linter is only as trustworthy as its model of the thing it's linting, so that
model is tested rather than assumed.

**Differential conformance testing.** Four oracles interrogate the real Claude
Code binary, and **none makes an API call** — so recording is free and CI can
replay on every commit.

*Doctor.* `claude doctor` reads a directory's settings files without a trust
prompt and reports everything it rejected — unknown hook events, malformed JSON,
skipped MCP servers — and, when it rejects an event, prints the complete list of
valid ones. That list is recorded, and a test asserts cclint's own list matches
it exactly. Adopting this oracle immediately exposed three live bugs: a
hand-written event list with **9 entries against the real 31** (so 22 valid
events were being reported as "this hook will never fire"), an MCP transport list
missing `ws` / `sdk` / `streamable-http`, and silent tolerance of JSON comments
that Claude Code rejects outright.

*MCP.* `claude mcp list` resolves the same layered config the runtime uses and
reports which servers it accepted and which it skipped. The suite asserts
agreement **in both directions**: every server Claude Code skips must produce an
error from us (no false negatives), and every server it accepts must produce
none (no false positives).

*Hooks.* Each fixture registers a `UserPromptSubmit` hook in a different settings
layer that appends its layer name to a log. `UserPromptSubmit` fires on every
prompt with no model decision involved — unlike `PreToolUse`, which only fires if
the model happens to pick that tool and would make the fixture flaky. The
recording captures which layers' hooks **actually executed**, and the test asserts
our resolver predicts exactly that set and marks nothing as shadowed. This is
what promotes the tool's headline claim from documentation to fact:

```
hooks-three-layer-accumulation → executed: user → projectShared → projectLocal
```

*Trust.* `claude --debug` reports which settings sources it loaded and which it
dropped, which is how the trust-gating claim gets pinned: the fixture supplies a
project `allow` list from an untrusted workspace and the recording shows Claude
Code ignoring it. This is the one finding users are most likely to disbelieve, so
it is the one that most needed an oracle rather than an argument.

The recording also captures **which directory** the binary keys trust on, because
that turned out not to be our project root. `.claude` is a strong root marker
here, so a directory holding one becomes our root — while Claude Code keeps
walking up to the enclosing **git root** and asks for `projects["<git root>"]`.
cclint printed its own root in the remediation line, so following the advice
exactly left the warning in place. The key is recorded relative to the fixture
(`"../../.."`) to stay machine-independent, and a test asserts ours matches.

Two things fell out of getting this right. A store can hold the same directory
under several keys — `D:/x` and `d:/x` — with **opposite** flags; returning the
first match made the verdict depend on object key order, so cclint now reports
trust as unknown and stays silent rather than calling a live `allow` list dead.
And the trust oracle now requires three runs to agree before recording: it ran
the binary once, and a single unstable reading was briefly enough to argue a
false positive into the permission rule and out again.

No API call is possible: the sandboxed home holds no credentials, `ANTHROPIC_API_KEY`
is stripped from the child environment, and the base URL points at a closed port.

**Recordings must be stable.** The hook oracle runs each probe three times and
refuses to record unless all runs agree. This is not paranoia — it caught a real
race where concurrent hook shells hadn't flushed before the process exited, which
would otherwise have baked in "this layer's hooks never fire" as a proven fact.

Pin the Claude Code version in CI and re-record on each release: a behaviour
change then shows up as a failing test with a readable diff, instead of as a
linter that has quietly gone wrong.

**Confidence tiers.** Every merge rule is tagged `conformance` (proven against
the binary), `documented`, or `assumed`. Findings that depend on an `assumed`
rule are automatically demoted in severity and say so. `cclint doctor` reports
the ratio.

A rule cannot be promoted by editing a label: `conformance` requires naming the
fixtures that prove it, and a meta-test asserts those fixtures exist and carry
recordings. Currently **3 of 32** rules is conformance-tier; 11 are `documented`
and 18 `assumed`, and `cclint doctor` prints the live breakdown.

*What the three are, and how they got there.* `hooks` came first, being the rule
whose blast radius is highest — getting it wrong means telling users to delete
hooks that are running. `env` and `permissions.defaultMode` followed once it
became clear the hook oracle had been under-used: a hook is a shell command
running inside the fully resolved runtime, before authentication and with no API
call, so it can report what that runtime *decided*, not merely that it fired. It
prints the environment it was handed, and its stdin payload carries the effective
`permission_mode`. No new mechanism was needed.

*And why "all-`conformance`" is not the goal.* Some rules cannot be proven this
way at any price: `permissions.allow` / `.deny` / `.ask` are only observable
through a real tool-use decision, which means the model, which means a billed API
call — so a free, replayable fixture cannot exist for them. Several cosmetic
scalars surface in no oracle at all. Reading `3/32` as "9% done" is therefore
wrong in a way that undersells the ceiling: roughly a third of the table is
reachable, and that is the number worth driving up.

**Severity policy.** `error` is reserved for what we can prove from the bytes on
disk. Anything depending on the environment is `warning`; anything semantic is
`info` and off by default. False positives are what get linters uninstalled.

---

## The semantic pass (opt-in)

Pure heuristics cannot tell you that *"prefer functional composition"*
contradicts *"model all domain concepts as classes"*. So the architecture is a
deterministic core with an optional semantic shell:

```bash
cclint --semantic
```

> **This sends rule text off your machine.** `--semantic` is the only thing in
> cclint that makes a network call for analysis, and what it transmits is the text
> of the candidate rule pairs — excerpts of your `CLAUDE.md`, not the whole file
> and no source code. The default destination is the Anthropic API; with
> `--semantic-provider` it can instead be Gemini
> (`generativelanguage.googleapis.com`), Groq (`api.groq.com`), OpenRouter
> (`openrouter.ai`), or a local Ollama on `localhost:11434`. Verdicts are cached
> to disk beside the rule text that produced them (`node_modules/.cache/cclint`,
> or `os.tmpdir()/cclint` outside a Node project), owner-readable only. Nothing
> here runs unless you pass the flag.

1. A deterministic prefilter picks **candidate pairs** — rules sharing a known
   decision axis or enough topical vocabulary. Everything else never reaches a
   model. Pairs are ranked (an axis match beats vocabulary overlap; rare words
   count for more than common ones) and **no single rule may occupy more than
   three pairs**. That cap matters more than it sounds: a long paragraph shares
   common words with everything, and without it one rule took 57% of the budget
   on a real 144-rule `CLAUDE.md` while 142 rules were never compared to each
   other at all. With it, the same budget covers 40 distinct rules.
2. Each pair gets one small structured-output call, with an explicit
   `insufficient_evidence` verdict so the judge can abstain instead of inventing
   conflicts to seem useful.
3. Verdicts are cached by content hash, so unchanged repos re-run for free.

Bounded by `--semantic-max-pairs` (default 40), and a capped run **says it was
capped** rather than reading as complete coverage.

**What the prefilter cannot reach — including this section's own example.** The
judge only ever sees pairs the prefilter selected, and selection needs a shared
axis or shared vocabulary. *"Prefer functional composition"* and *"model every
domain concept as a class"* share neither: no axis covers them, and they have
almost no words in common. So the contradiction this section opens with is one the
pass will not currently find.

Measured, not theorised: a fixture of five deliberate contradictions surfaced
**two** candidate pairs. The three misses were the ones phrased in disjoint
vocabulary — composition vs. classes, two-reviewer vs. self-merge, and
no-comments vs. document-the-reasoning. `test/semantic.test.ts` asserts that
2-of-5 figure, so this paragraph cannot quietly go stale.

That is the honest boundary of a cheap deterministic prefilter: it buys a bounded
model bill at the cost of recall on rules that disagree in meaning while sharing
no surface. Widening it (embeddings, or a cheap first-pass triage over all pairs)
is the obvious next step and is not implemented. Until it is, read a clean
`--semantic` run as *"nothing found among the pairs it examined"*, and check the
reported candidate-pair count — a run reporting `0 candidate pairs` examined
nothing at all.

---

## Configuration

`.cclint.json` at the project root:

```jsonc
{
  "ignore": ["hooks/command-not-on-path"],
  "severity": { "memory/redundant-across-layers": "error" },
  // Project-relative globs dropped from discovery entirely — no findings, no
  // token cost. For example/ or fixture config that is real but describes a
  // test scenario rather than this project.
  "excludePaths": ["test/fixtures/**", "examples/**"],
  "model": "claude-opus-5",
  // Extend the conflict-axis library without patching source.
  "axes": [
    {
      "id": "orm",
      "label": "database access layer",
      "sides": [
        { "name": "prisma", "patterns": ["\\bprisma\\b"] },
        { "name": "drizzle", "patterns": ["\\bdrizzle\\b"] }
      ]
    }
  ]
}
```

---

## GitHub Action

```yaml
- uses: Santhosraj/Claude_Linter@v0.2.4   # or @main to track the branch
  with:
    fail-on: error
    # Optional. Without it the action still runs fully; token figures
    # are reported as estimates.
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Emits SARIF, so findings render as inline annotations on the diff.

**Pinning has two halves, and pinning the action is only one of them.** The
`version` input defaults to `latest`, so the action installs the newest published
`cclint` at run time — a run can change behaviour with no change to your
repository, even from a tag or a commit SHA. Pin both to make a run reproducible:

```yaml
- uses: Santhosraj/Claude_Linter@v0.2.4
  with:
    version: 0.2.4
```

**Reading the SARIF yourself.** The action uploads it for you by default. If you
want the file, read the fixed path rather than the output:

```yaml
- uses: Santhosraj/Claude_Linter@v0.2.4
  continue-on-error: true
- run: ./triage "$RUNNER_TEMP/cclint.sarif"
```

`outputs.sarif-file` is best-effort: outputs are not reliably exported when the
action fails, and the action fails whenever a finding meets `fail-on` — so the
output can be empty in exactly the case where you wanted the path. The file is
always written to `$RUNNER_TEMP/cclint.sarif`, which needs no propagation
mechanism and was verified on a runner to be present and non-empty on a failing
run.

---

## Development

```bash
npm install
npm test                    # unit + differential conformance
npm run conformance:record  # re-record oracle verdicts (needs claude on PATH)
npm run build
```

Exit codes: `0` clean, `1` findings at or above `--fail-on`, `2` the tool itself
failed.
