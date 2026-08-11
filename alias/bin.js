#!/usr/bin/env node
/**
 * `cclint` — the short name, so `npx cclint` works.
 *
 * npx resolves a PACKAGE name, not a bin name. Without this package,
 * `npx cclint` fails with E404 no matter what `claude-config-lint` declares in
 * its own `bin`, because npx has no way to know the two are related.
 *
 * This is a real import, not a spawn. A child process would need its own exit
 * code plumbing and would lose TTY detection, so colour and the "is this a
 * terminal" branch would silently change behaviour depending on how you invoked
 * the tool. Importing keeps one process: argv, stdout, the TTY and the exit code
 * are all the real ones.
 *
 * `claude-config-lint/cli` is a declared export of that package, not a reach
 * into its dist/ layout, so this keeps working if the build output moves.
 */

import "claude-config-lint/cli";
