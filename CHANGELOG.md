# Changelog

Notable changes to `@santhosraj/cclint`. Entries say what changed for *you* — a
new finding, a changed exit code, a corrected number — not which files moved.

Two things get called out explicitly wherever they apply, because they are the
ones that can break a green build or a trusted report:

- **New finding** — a check that did not exist before. If it is `error`-tier it
  can fail a CI job that passed on the previous version.
- **Correctness** — cclint was previously *wrong*. Worth knowing which of your
  past clean runs you should not have believed.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).
While the major version is `0`, a minor bump may change finding output.

## [Unreleased]

### Correctness

- The `permissions/untrusted-workspace` finding no longer contradicts itself. It
  fires on a gated `settings.local.json` while its own detail text told you
  `settings.local.json` allow lists were unaffected — a leftover sentence from a
  narrowing that was reverted once repeat probes showed the binary gates both
  project files. The behaviour was always right; the sentence a user actually
  reads was not. It now names both gated files, and a test asserts the wording.

### Internal

- Removed the raw NUL bytes from `src/rules/permissions.ts` and
  `src/semantic/adjudicate.ts`. Both used one as a map-key or hash-key separator,
  written as a literal control character rather than as an escape sequence.
  Byte-identical at runtime — cached verdicts and token counts stay valid — but it
  made ripgrep classify both files as binary and skip them, so a search across
  `src/` silently excluded the largest rule file and the whole semantic shell. A
  test now scans the tree for control bytes.

## [0.2.3] — 2026-08-17

### Correctness — three ways real conflicts were being discarded

The heuristic conflict detector silently dropped findings. If an earlier run
reported no conflicts in your `CLAUDE.md`, re-run it on this version.

- A rule stated as a **rejection** ("never use tabs") no longer counts as
  *choosing* that side. Previously a lone "never use tabs" was classified as
  choosing tabs, so it looked like it conflicted with "use spaces" — and worse,
  the genuine pair was misread.
- A negation cue is now only honoured when it actually **precedes the match**.
  The old implementation used a whole-string lookahead, so the word "not"
  anywhere in a long rule disabled detection for the entire rule.
- Two conflicting rules **under the same heading** are reported again. Both the
  axis rule and the semantic prefilter skipped same-section pairs outright; a
  section titled "Style" containing both sides of a contradiction was the
  blind spot. Same-section pairs are now ranked below cross-section ones in the
  semantic prefilter rather than dropped.

### Correctness — context-window figures

- The context-window table was rebuilt. `mythos-5` was missing, Haiku 4.5 is
  matched before the general patterns (it is 200K, not 1M), and a bare `1m` no
  longer matches an unrelated model name.
- A window cclint had to **guess** now says so: the budget report reads
  "an assumed 200,000-token window" instead of presenting the fallback as fact.
- The context share is rendered identically in both places that print it. They
  disagreed in the last decimal.

### Added

- `CLAUDE_CONFIG_DIR` is honoured. Config discovery follows it, and — this is
  the part that is easy to get wrong — so does the workspace trust store, which
  moves *inside* the relocated directory rather than staying a sibling of it.
- Findings and `doctor` now print **which trust store was consulted** and the
  **trust key** (your git root, not the working directory). When no store exists
  — CI, containers — the finding says so, instead of reporting your allow list
  as ignored with no explanation.
- **New finding** `memory/filename-case` (warning): a `claude.md` or `Claude.md`
  that differs from `CLAUDE.md` only by case. On Windows and macOS it loads; on
  a Linux CI runner it does not. Real filename casing is now recorded, so the
  report stops displaying the name you expected instead of the name on disk.
- **New finding** `memory/large-always-loaded` (warning): always-loaded memory
  over 10,000 tokens. Diagnostics now run before severity filtering, so this
  respects `--strict` and `--fail-on` like every other rule.

### Changed

- Conformance tier: **3 of 32** merge rules are now proven against the Claude
  Code binary, up from 1. `env` and `permissions.defaultMode` were promoted with
  recorded provenance. The trust oracle requires three agreeing runs before it
  records anything — one unstable reading previously produced a wrong conclusion
  about `settings.local.json`.
- Semantic and token caches are written owner-only (`0o600`, in a `0o700`
  directory). The fallback cache location is the shared `os.tmpdir()`, and the
  semantic cache holds excerpts of your rule text. No effect on Windows, which
  has no POSIX modes.
- The reported version is read from `package.json` instead of a hardcoded
  constant that had already drifted.

### GitHub Action

The composite action had **never been executed** before this release. It now has
a self-test that runs on every PR and every push to `main`.

- `fail-on` is enforced in a separate final step. The mechanism matters to
  anyone reading `outputs.sarif-file`: the runner applies a step's
  `$GITHUB_OUTPUT` **after** the step and skips it when the step fails, so a
  failing lint produced an empty output. Enforcement moved out so the linter
  step can succeed and publish.
- `outputs.sarif-file` is documented as **best-effort**. The SARIF is always
  written to `$RUNNER_TEMP/cclint.sarif` — read that fixed path on a failing
  run. Verified on a runner, not assumed.

### Documentation

- `--semantic` **data egress** is documented: it is the only network call cclint
  makes for analysis, it transmits the text of candidate rule pairs, and the
  destination depends on `--semantic-provider` (Anthropic, Gemini, Groq,
  OpenRouter, or a local Ollama).
- The prefilter's **recall limit** is stated, using the README's own headline
  example as the counter-example: "prefer functional composition" vs "model
  domain concepts as classes" share no axis and no vocabulary, so the pass does
  not currently find it. Measured on a fixture, not theorised.

## [0.2.2] — 2026-08-16

### Added

- Detection of a memory file whose name differs from `CLAUDE.md` only by case.
- Reporting of an always-loaded context large enough to matter.
- `RELEASING.md`, documenting the two publishing traps that caught this project:
  a name absent from the npm registry is not necessarily *publishable* (npm
  rejects names too similar to an existing one), and a globally installed
  `cclint` shadows `npx`, which makes a "fresh user" smoke test lie.

## [0.2.1] — 2026-08-16

### Correctness

- `explain` no longer contradicts the lint. It reported a trust-gated
  `permissions.allow` as active while the lint correctly reported it as ignored.

### Changed

- Published as `@santhosraj/cclint`. The registry refused both unscoped names —
  `claude-config-lint` is taken by an unrelated author, and `cclint` was
  rejected as too similar to the existing `cc-lint`.
- `doctor` shows the trust key when it differs from the project root.
- CI builds before testing. Eleven tests had been skipping silently because they
  exercise the built CLI, so the suite was green without running them.

## [0.2.0] — 2026-08-15

Initial public release: deterministic linting of `CLAUDE.md`, hooks, MCP
servers, settings, and permissions, with SARIF output, a GitHub Action, and an
opt-in semantic pass.

[0.2.3]: https://github.com/Santhosraj/Claude_Linter/releases/tag/v0.2.3
[0.2.2]: https://github.com/Santhosraj/Claude_Linter/releases/tag/v0.2.2
[0.2.1]: https://github.com/Santhosraj/Claude_Linter/releases/tag/v0.2.1
[0.2.0]: https://github.com/Santhosraj/Claude_Linter/releases/tag/v0.2.0
