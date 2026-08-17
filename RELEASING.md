# Releasing

One package: **`@santhosraj/cclint`**, installing a command called **`cclint`**.

`publishConfig.access` is set to `public` in package.json, so a plain
`npm publish` works. Scoped packages default to restricted, and forgetting
`--access=public` is the classic first-release failure.

The registry decided this name, after refusing two others:

| Name | Outcome |
|---|---|
| `claude-config-lint` | owned by an unrelated author — `403 You do not have permission` |
| `cclint` (unscoped) | `403 too similar to existing package cc-lint` |
| `@santhosraj/cclint` | your own scope; cannot collide |

Worth knowing for any future rename: **`npm view <name>` returning 404 does not
mean the name is publishable.** Both rejected names were absent from the
registry. Ownership and the similarity check are only evaluated server-side when
you publish, so a name is unproven until an actual publish succeeds.

It used to be two packages. `claude-config-lint` was the core and `cclint` a
one-line alias wrapping it, which existed only so `npx cclint` would resolve at
all. That structure is gone, and with it an exact-version pin between the two, a
sync script, a publish-order rule, and a whole class of release-day mistake where
the most-advertised entry point silently ran old code.

The alias stopped earning its keep once the core could not take the short name
either. A scoped package installs the `cclint` command directly, so the only
thing lost is brevity in `npx`, and the only thing gained by an alias would be
that brevity at the cost of everything listed above.

## Steps

```bash
# 0. Write the CHANGELOG entry and bump the version pins in the README's GitHub
#    Action snippets, THEN commit — before `npm version`, so the release commit
#    and its tag contain the notes for that release rather than trailing it. The
#    changelog ships in the tarball (`files` lists it explicitly; npm guarantees
#    only README and LICENSE).

# 1. Set the version. This also COMMITS the bump and creates a `v<version>` tag —
#    npm does both unless you pass --no-git-tag-version. Do not tag by hand
#    afterwards; it already exists and `git tag` will refuse.
npm version <next>    # e.g. 0.2.5

# 2. Full gate. prepublishOnly runs this again, but failing here is cheaper.
#    test:strict, not test: it also asserts every suite in test/ actually ran.
npm run typecheck && npm run test:strict && npm run build

# 3. Re-derive the conformance recordings from the installed binary.
#    Free — no API call. A behaviour change in Claude Code shows up here as a
#    failing test with a readable diff rather than as a linter gone quietly wrong.
npm run conformance:record && npm run test:strict

# 4. Publish.
npm publish

# 5. Push the commit AND the tag. `npm version` made both locally and pushes
#    neither, so it is easy to ship to npm and leave the repository behind —
#    the Action can be pinned to a release only once the tag is on the remote.
git push origin main
git push origin "v$(node -p "require('./package.json').version")"
```

Publishing requires 2FA. The CLI opens a browser to authenticate, so recovery
codes are enough — no authenticator app is needed. For a token-based publish
(CI, where no browser exists), create a **granular** access token with *bypass
2FA* enabled.

## Verify the published artifact

**Wait a minute before verifying, and do not panic at a 404.** npm's publish path
and its read path are separate systems. For a minute or so after a successful
`+ @santhosraj/cclint@x.y.z`, the package can still 404 for `npm install`, `npx`,
`npm view` and a raw registry GET — while `npm access list packages` already shows
you own it. That combination is the signature of read-side lag, not a failed
publish.

This happened on 0.2.0 and cost real time chasing a phantom. If you see it:

```bash
npm access list packages | grep cclint    # owns it? then the publish DID land
```

Re-publishing the same version will be refused as a conflict, and renaming would
burn a name for nothing. Wait and re-check; it resolved within 30 seconds.

Do not trust a green test suite as evidence that the package works — it tests the
source tree, not the tarball. Two defects reached this project by exactly that
gap: a `bin` pointing at a TypeScript entry that could never execute, and a
hardcoded `VERSION` that made a build report the previous release from both
`--version` and every SARIF report.

Install what a stranger would get:

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null
npm install @santhosraj/cclint
printf '{ "model": "x", }\n' > settings.json && mkdir -p .claude && mv settings.json .claude/
./node_modules/.bin/cclint --offline    # expect: json/not-strict-json, exit 1
./node_modules/.bin/cclint --version    # expect: the version you just published
```

**Use the explicit path, or pin the version.** A bare `cclint`, or
`npx @santhosraj/cclint` without a version, prefers a binary already installed on
the machine over the registry, silently —
so a stale global install will shadow the release you are trying to verify and
report success. That is not hypothetical: it made a broken published package look
healthy during the 0.2.0 work. `npx @santhosraj/cclint@<version>` forces the
registry.

## Version support

Pin the Claude Code version used to record conformance fixtures, and re-record on
each of its releases. The tool's accuracy is bounded by how well its model of
Claude Code matches the real binary, and that is the only mechanism that keeps
the two in step.

You no longer have to remember. `.github/workflows/conformance-drift.yml` asks npm
weekly whether a newer Claude Code exists than the fixtures were recorded against,
and opens a single tracking issue when one does — closing it again once you
re-record. It detects the trigger, not the drift: the hook and runtime oracles need
an authenticated binary, so re-recording still happens on your machine.
