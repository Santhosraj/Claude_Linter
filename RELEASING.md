# Releasing

One package: **`cclint`**. The bin and the package share that name, so
`npx cclint` resolves directly — npx looks up a package name, not a bin name.

It used to be two. `claude-config-lint` was the core and `cclint` a one-line
alias wrapping it, which existed only so `npx cclint` would resolve at all. That
structure is gone, and with it an exact-version pin between the two, a sync
script, a publish-order rule, and a whole class of release-day mistake where the
most-advertised entry point silently ran old code.

The reason for the collapse is worth recording: `claude-config-lint` on npm
belongs to **someone else** — an unrelated project by another author. The name
was never available to this project, and the first release attempt failed with
`403 You do not have permission to publish`. `cclint` was free, and it is the
name the documentation already led with.

## Steps

```bash
# 1. Set the version in package.json.

# 2. Full gate. prepublishOnly runs this again, but failing here is cheaper.
npm run typecheck && npm test && npm run build

# 3. Re-derive the conformance recordings from the installed binary.
#    Free — no API call. A behaviour change in Claude Code shows up here as a
#    failing test with a readable diff rather than as a linter gone quietly wrong.
npm run conformance:record && npm test

# 4. Publish.
npm publish

# 5. Tag, so the GitHub Action can be pinned to a release.
git tag v$(node -p "require('./package.json').version")
git push --tags
```

Publishing requires 2FA. The CLI opens a browser to authenticate, so recovery
codes are enough — no authenticator app is needed. For a token-based publish
(CI, where no browser exists), create a **granular** access token with *bypass
2FA* enabled.

## Verify the published artifact

Do not trust a green test suite as evidence that the package works — it tests the
source tree, not the tarball. Two defects reached this project by exactly that
gap: a `bin` pointing at a TypeScript entry that could never execute, and a
hardcoded `VERSION` that made a build report the previous release from both
`--version` and every SARIF report.

Install what a stranger would get:

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null
npm install cclint
printf '{ "model": "x", }\n' > settings.json && mkdir -p .claude && mv settings.json .claude/
./node_modules/.bin/cclint --offline    # expect: json/not-strict-json, exit 1
./node_modules/.bin/cclint --version    # expect: the version you just published
```

**Use the explicit path, or pin the version.** A bare `npx cclint` prefers a
binary already installed on the machine over the registry, silently — so a stale
global install will shadow the release you are trying to verify and report
success. `npx cclint@<version>` forces the registry.

## Version support

Pin the Claude Code version used to record conformance fixtures, and re-record on
each of its releases. The tool's accuracy is bounded by how well its model of
Claude Code matches the real binary, and that is the only mechanism that keeps
the two in step.
