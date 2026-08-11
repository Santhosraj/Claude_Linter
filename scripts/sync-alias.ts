/**
 * Stamp the alias package from the core package.
 *
 * Two published packages that must move together is a standing hazard: publish
 * the core as 0.2.0 and forget the alias, and `npx cclint` keeps silently
 * installing 0.1.0 — the users on the shortest, most-advertised entry point are
 * the ones left on stale code, with nothing in the output to say so. The alias
 * therefore pins an EXACT core version rather than a range, this script is the
 * only way that version is written, and `test/alias.test.ts` fails the build if
 * the two ever disagree.
 */

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const aliasDir = join(root, "alias");

const core = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
  name: string;
};
const aliasFile = join(aliasDir, "package.json");
const alias = JSON.parse(readFileSync(aliasFile, "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
};

alias.version = core.version;
alias.dependencies[core.name] = core.version;

writeFileSync(aliasFile, `${JSON.stringify(alias, null, 2)}\n`);
copyFileSync(join(root, "LICENSE"), join(aliasDir, "LICENSE"));

console.log(`alias: cclint@${alias.version} → ${core.name}@${core.version}`);
