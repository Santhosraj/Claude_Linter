# claude-config-lint

Lint the configuration a Claude Code project accumulates — `CLAUDE.md`, hooks,
MCP servers — for the failures that are silent until the agent starts behaving
oddly: dead references, config that a higher layer quietly overrides,
instructions that contradict each other, and context you're paying for on every
turn without realising it.

```bash
npx cclint                        # run it once, no install
npx cclint doctor                 # what was discovered, and why
npx cclint explain hooks.PreToolUse
npx cclint budget
```

`cclint` is a thin alias package; `npx claude-config-lint` is the same tool by
its full name, and `npm install -g claude-config-lint` puts `cclint` on your
`PATH` for good.

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
`npx cclint` prefers whatever is already on your machine over the registry — so
a stale global install will shadow a newer release without saying so. `cclint
--version` tells you which one you are actually running.

> **Quote paths containing spaces.** `--cwd "D:\my project"`, not `--cwd D:\my project`.
> Unquoted, the shell splits the path and the flag receives only the first
> fragment. `cclint` rejects that with exit 2 rather than guessing — but the
> quotes save you the round trip.

Start with `doctor`. It prints the project root, the marker that decided it, and
every config file found — so you can confirm discovery is right before trusting
any finding.

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
  across two files that are both always in context

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
rule are automatically demoted in severity and say so. `cclint doctor`
reports the ratio; the goal is to drive it to all-`conformance`.

A rule cannot be promoted by editing a label: `conformance` requires naming the
fixtures that prove it, and a meta-test asserts those fixtures exist and carry
recordings. Currently **1 of 32** rules is conformance-tier — `hooks`, the one
whose blast radius is highest, since getting it wrong means telling users to
delete hooks that are running. 13 are `documented` and 18 `assumed`; `cclint
doctor` prints the live breakdown, and that number is the honest measure of how
far this has to go.

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
# Pin to a release tag once one exists; `@main` always resolves.
- uses: Santhosraj/Claude_Linter@main
  with:
    fail-on: error
    # Optional. Without it the action still runs fully; token figures
    # are reported as estimates.
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Emits SARIF, so findings render as inline annotations on the diff.

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
