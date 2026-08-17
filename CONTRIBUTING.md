# Contributing

Thanks for looking. The short version: **a bug report with the config that
triggered it is worth more than a patch**, because the hard part of this project
is knowing what Claude Code actually does, not writing the check.

## Reporting a false positive or false negative

These are the most valuable reports, and the ones this project is built to take
seriously — a linter people don't trust gets uninstalled.

Include the config that triggered it, reduced as far as you can, plus the output
of:

```bash
cclint doctor
```

`doctor` prints the project root, the marker that decided it, which files were
read, and the trust key — which is where most surprising results come from.
**Redact anything sensitive**: settings files can hold API keys in `env` blocks
and MCP `headers`. Nobody needs those to reproduce a finding.

If cclint told you something was wrong and it wasn't, say what you expected
Claude Code to do and, if you know, why. That is the input this project cannot
generate on its own.

## Getting set up

```bash
npm install
npm run typecheck
npm run test:strict     # not `npm test` — see below
npm run build
npx tsx src/cli.ts doctor   # run the CLI straight from source
```

Node 20 or newer. No other prerequisites, and no API key: the deterministic core
is entirely offline.

Use `test:strict` rather than `test`. It writes a JSON report and asserts that
every suite in `test/` actually ran — the forks pool can lose a worker under load
on Windows and print a green summary covering one file less than it did before.

## How this codebase thinks

Three ideas explain most of the decisions, and a change that violates one will be
questioned:

**1. Precision over recall.** `error` is reserved for what can be proven from the
bytes on disk. Anything depending on the environment is `warning`; anything
semantic is `info` and off by default. A false positive costs far more than a
missed finding, because it is what gets a linter uninstalled.

**2. Claims about Claude Code need evidence, and the tier is visible.** Every
merge rule carries a confidence tier — `conformance` (proven against the real
binary by a recorded fixture), `documented` (stated in docs), or `assumed`. Run
`cclint doctor` to see the ratio. Promoting a rule to `conformance` means adding
an oracle in `scripts/oracle.ts` that derives the answer from the binary, and a
meta-test enforces that a `conformance` claim has recorded provenance — you
cannot promote a rule by editing a string. If you're unsure which tier applies,
`assumed` is the honest answer.

**3. Nothing may pass while proving nothing.** A check that can report success
without having checked anything is treated as a defect here, not a convenience.
This project has shipped that failure twice — eleven tests skipped themselves in
CI for weeks because the build ran after them, and a suite silently vanished from
a green local run — so guards now assert their own preconditions. If you add a
check, make it fail loudly when it cannot do its job.

## Things worth knowing before you start

- **Merge semantics are per-key, not "higher layer wins."** `hooks` are additive
  across every layer, `permissions.allow`/`deny`/`ask` are unioned, `env` is
  deep-merged, and only scalars like `model` override. Modelling this as "higher
  layer wins" produces confidently wrong output. See
  [`src/model/merge-semantics.ts`](src/model/merge-semantics.ts).
- **`CLAUDE.md` files don't override each other**, they concatenate. Two files
  stating opposite things is a live conflict with nothing to resolve it.
- **Windows is a first-class target.** The tool was developed there and CI runs
  Linux, macOS, and Windows on Node 20 and 22. Path handling is most of this
  codebase; `\` vs `/`, absolute-path detection, and the home-directory boundary
  all have real tests.
- **Don't embed raw control bytes in source.** Use an escape. A NUL makes ripgrep
  classify the file as binary and skip it silently, which happened to two files
  here; `test/source-hygiene.test.ts` now fails on it.

## Re-recording conformance fixtures

Needs an authenticated Claude Code on your machine:

```bash
npm run conformance:record
npm run test:strict
```

A behaviour change in Claude Code shows up as a failing test with a readable
diff. `.github/workflows/conformance-drift.yml` opens an issue when a new Claude
Code release makes the fixtures stale, so you don't have to watch for it.

## Pull requests

- One concern per PR, and say what you verified rather than what you intended.
- Explain **why** in the commit message. The reasoning is the part that can't be
  recovered from the diff later.
- New behaviour needs a test. A bug fix needs a test that fails before it.
- Don't edit `test/fixtures/**/.conformance/` by hand — those are recordings
  compared byte-for-byte against the binary. Re-record instead.
- Release mechanics are in [`RELEASING.md`](RELEASING.md); maintainers handle
  publishing.

Licensed MIT. By contributing you agree your work ships under the same license.
