# Releasing

Two packages ship together:

| Package | What it is |
|---|---|
| `claude-config-lint` | the tool |
| `cclint` | a one-line alias so `npx cclint` resolves — npx looks up a package name, not a bin name |

The alias pins an **exact** core version. That is deliberate: a range would let
`npx cclint` drift onto a core it was never tested against, and a stale pin
leaves the users on the shortest, most-advertised entry point silently running
old code. `test/alias.test.ts` fails the build if the two versions disagree, so
the mistake cannot reach the registry quietly.

## Steps

```bash
# 1. Set the version in package.json, then stamp the alias from it.
npm run sync:alias

# 2. Full gate. prepublishOnly runs this again, but failing here is cheaper.
npm run typecheck && npm test && npm run build

# 3. Re-derive the conformance recordings from the installed binary.
#    Free — no API call. A behaviour change in Claude Code shows up here as a
#    failing test with a readable diff rather than as a linter gone quietly wrong.
npm run conformance:record && npm test

# 4. Publish the core FIRST — the alias depends on it and will not install
#    until it exists on the registry.
npm publish
npm publish ./alias

# 5. Tag, so the GitHub Action can be pinned to a release.
git tag v$(node -p "require('./package.json').version")
git push --tags
```

## Verify the published artifact

Do not trust a green test suite as evidence that the package works — it tests
the source tree, not the tarball. Install what a stranger would get:

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null
npm install claude-config-lint
printf '{ "model": "x", }\n' > settings.json && mkdir -p .claude && mv settings.json .claude/
./node_modules/.bin/cclint --offline    # expect: json/not-strict-json, exit 1
npx cclint doctor                       # expect: the alias resolves
```

This caught a real defect before 0.1.0: the README's opening block said
`npx cclint`, which would have been an E404 for every new user, because no
package by that name existed yet.

## Version support

Pin the Claude Code version used to record conformance fixtures, and re-record
on each of its releases. The tool's accuracy is bounded by how well its model of
Claude Code matches the real binary, and that is the only mechanism that keeps
the two in step.
