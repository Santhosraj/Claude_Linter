import { describe, expect, it } from "vitest";

import { parseEntry, resolvePermissionPath, subsumes } from "../src/rules/permissions.js";
import { resolveSettings } from "../src/resolve/settings.js";
import { permissionRules } from "../src/rules/permissions.js";
import type { RuleContext } from "../src/rules/context.js";
import type { Diagnostic } from "../src/model/types.js";

/**
 * Permission-list rules.
 *
 * These were written against a real config: a 33-entry `permissions.allow`
 * list accumulated over a debugging session, where 10 entries referenced
 * another machine's macOS paths and most of the rest were already covered by
 * four broad wildcards. cclint previously reported that file as clean.
 */

function ctxFor(
  files: { file: string; layer: "user" | "projectShared" | "projectLocal"; json: unknown }[],
  trusted: boolean | undefined = true,
): RuleContext {
  const resolution = resolveSettings(
    files.map((f) => ({ file: f.file, layer: f.layer, text: JSON.stringify(f.json, null, 2) })),
  );
  return {
    discovery: {
      projectRoot: "/proj",
      workspaceTrust: { trusted },
      rootProvenance: { root: "/proj", source: "forced" },
      startedFrom: "/proj",
      home: "/home",
      settings: [],
      memory: [],
      mcp: [],
      claudeDirs: [],
    },
    resolution,
    memory: [],
    keys: resolution.keys,
    parsed: resolution.parsed,
  };
}

const run = (
  files: Parameters<typeof ctxFor>[0],
  trusted: boolean | undefined = true,
): Diagnostic[] => permissionRules(ctxFor(files, trusted));

describe("subsumption", () => {
  it("treats `cmd:*` as a prefix grant", () => {
    expect(subsumes("Bash(curl:*)", "Bash(curl -s http://x)")).toBe(true);
    expect(subsumes("Bash(ssh:*)", "Bash(ssh -o Foo=bar host)")).toBe(true);
  });

  it("does NOT subsume when the prefix differs by a single character", () => {
    // The real-world trap. `Bash(python3 -c ':*)` ends in a SINGLE quote; the
    // specific entries use a DOUBLE quote. A fuzzy matcher would collapse them
    // and tell the user to delete twelve grants that are actually load-bearing.
    expect(
      subsumes(`Bash(python3 -c ':*)`, `Bash(python3 -c "import sys,json; print(1)")`),
    ).toBe(false);
  });

  it("does not subsume across different tools", () => {
    expect(subsumes("Bash(curl:*)", "Read(curl -s x)")).toBe(false);
  });

  it("treats a bare tool grant as covering every scoped grant", () => {
    expect(subsumes("Bash", "Bash(anything at all)")).toBe(true);
    expect(subsumes("Bash(x:*)", "Bash")).toBe(false);
  });

  it("treats `path/**` as covering everything beneath it", () => {
    expect(subsumes("Read(//a/b/**)", "Read(//a/b/c/**)")).toBe(true);
    expect(subsumes("Read(//a/b/**)", "Read(//a/bother/**)")).toBe(false);
  });

  it("never reports an entry as subsuming itself", () => {
    expect(subsumes("Bash(curl:*)", "Bash(curl:*)")).toBe(false);
  });
});

describe("entry parsing", () => {
  it("splits tool and specifier", () => {
    expect(parseEntry("Bash(npm run test)")).toEqual({ tool: "Bash", specifier: "npm run test" });
    expect(parseEntry("Bash")).toEqual({ tool: "Bash", specifier: undefined });
  });

  it("keeps nested parentheses in the specifier", () => {
    expect(parseEntry(`Bash(python3 -c "print(1)")`).specifier).toBe(`python3 -c "print(1)"`);
  });
});

describe("path resolution", () => {
  it("treats a leading // as an absolute path", () => {
    expect(resolvePermissionPath("//Users/x/Desktop/**", "/proj")).toBe("/Users/x/Desktop");
  });

  it("stops at the first wildcard", () => {
    expect(resolvePermissionPath("//a/b/**/c", "/proj")).toBe("/a/b");
  });

  it("ignores non-path specifiers", () => {
    expect(resolvePermissionPath("domain:example.com", "/proj")).toBeUndefined();
  });
});

describe("rules end to end", () => {
  it("flags an entry covered by a broader wildcard", () => {
    const out = run([
      {
        file: "/proj/.claude/settings.local.json",
        layer: "projectLocal",
        json: { permissions: { allow: ["Bash(curl -s http://x)", "Bash(curl:*)"] } },
      },
    ]);
    const redundant = out.filter((d) => d.ruleId === "permissions/redundant-entry");
    expect(redundant).toHaveLength(1);
    expect(redundant[0]?.data?.["coveredBy"]).toBe("Bash(curl:*)");
  });

  it("flags exact duplicates across layers", () => {
    const out = run([
      { file: "/home/.claude/settings.json", layer: "user", json: { permissions: { allow: ["Bash(ls)"] } } },
      {
        file: "/proj/.claude/settings.json",
        layer: "projectShared",
        json: { permissions: { allow: ["Bash(ls)"] } },
      },
    ]);
    expect(out.filter((d) => d.ruleId === "permissions/duplicate-entry")).toHaveLength(1);
  });

  it("does not compare allow against deny", () => {
    // A broad deny does not make an allow redundant — it conflicts with it.
    const out = run([
      {
        file: "/proj/.claude/settings.local.json",
        layer: "projectLocal",
        json: { permissions: { allow: ["Bash(curl -s x)"], deny: ["Bash(curl:*)"] } },
      },
    ]);
    expect(out.filter((d) => d.ruleId === "permissions/redundant-entry")).toEqual([]);
  });

  it("flags a dead path in a machine-specific layer", () => {
    const out = run([
      {
        file: "/proj/.claude/settings.local.json",
        layer: "projectLocal",
        json: { permissions: { allow: ["Read(//definitely/not/here/**)"] } },
      },
    ]);
    expect(out.filter((d) => d.ruleId === "permissions/dead-path")).toHaveLength(1);
  });

  it("stays silent about dead paths in a SHARED settings file", () => {
    // A checked-in settings.json describes every teammate's machine. Flagging a
    // colleague's macOS path on a Windows checkout would be a false positive on
    // a perfectly correct file.
    const out = run([
      {
        file: "/proj/.claude/settings.json",
        layer: "projectShared",
        json: { permissions: { allow: ["Read(//Users/someone/Desktop/**)"] } },
      },
    ]);
    expect(out.filter((d) => d.ruleId === "permissions/dead-path")).toEqual([]);
  });

  it("does not treat a non-path specifier as a dead path", () => {
    const out = run([
      {
        file: "/proj/.claude/settings.local.json",
        layer: "projectLocal",
        json: { permissions: { allow: ["WebFetch(domain:example.com)", "Bash(ls)"] } },
      },
    ]);
    expect(out.filter((d) => d.ruleId === "permissions/dead-path")).toEqual([]);
  });

  it("reports project allow entries as ignored in an untrusted workspace", () => {
    const out = run(
      [
        {
          file: "/proj/.claude/settings.json",
          layer: "projectShared",
          json: { permissions: { allow: ["Bash(ls:*)", "Bash(echo:*)"] } },
        },
      ],
      false,
    );
    const trust = out.filter((d) => d.ruleId === "permissions/untrusted-workspace");
    expect(trust).toHaveLength(1);
    expect(trust[0]?.data?.["count"]).toBe(2);
  });

  it("does NOT claim deny or ask are ignored when untrusted", () => {
    // Verified against the binary: only project-layer `allow` is gated. Saying
    // a `deny` is being ignored would tell someone a security guard is off when
    // it is not — the most damaging direction to be wrong in.
    const out = run(
      [
        {
          file: "/proj/.claude/settings.json",
          layer: "projectShared",
          json: { permissions: { deny: ["Bash(rm:*)"], ask: ["Bash(git push:*)"] } },
        },
      ],
      false,
    );
    expect(out.filter((d) => d.ruleId === "permissions/untrusted-workspace")).toEqual([]);
  });

  it("does NOT gate the project-local allow list", () => {
    // Probed against 2.1.229 in a git-rooted project carrying allow entries in
    // both project files: the binary named `settings.json` alone and its
    // ignored-entry count excluded the local layer. Gating "project layers" as
    // a group is the intuitive reading and it over-reports — it calls a grant
    // dead that Claude Code is honouring. Pinned by
    // test/fixtures/permissions-untrusted-allow-multilayer.
    const out = run(
      [
        {
          file: "/proj/.claude/settings.local.json",
          layer: "projectLocal",
          json: { permissions: { allow: ["Bash(cat:*)"] } },
        },
      ],
      false,
    );
    expect(out.filter((d) => d.ruleId === "permissions/untrusted-workspace")).toEqual([]);
  });

  it("does NOT gate the user's own allow list", () => {
    const out = run(
      [
        {
          file: "/home/.claude/settings.json",
          layer: "user",
          json: { permissions: { allow: ["Bash(whoami:*)"] } },
        },
      ],
      false,
    );
    expect(out.filter((d) => d.ruleId === "permissions/untrusted-workspace")).toEqual([]);
  });

  it("suppresses other findings for entries that are being ignored", () => {
    // One actionable finding beats thirteen about config that is not in effect.
    const out = run(
      [
        {
          file: "/proj/.claude/settings.json",
          layer: "projectShared",
          json: { permissions: { allow: ["Bash(curl -s x)", "Bash(curl:*)"] } },
        },
      ],
      false,
    );
    expect(out.map((d) => d.ruleId)).toEqual(["permissions/untrusted-workspace"]);
  });

  it("says nothing about trust when it cannot determine the state", () => {
    const out = run(
      [
        {
          file: "/proj/.claude/settings.json",
          layer: "projectShared",
          json: { permissions: { allow: ["Bash(ls:*)"] } },
        },
      ],
      undefined,
    );
    expect(out.filter((d) => d.ruleId === "permissions/untrusted-workspace")).toEqual([]);
  });

  it("ignores permissions in a file Claude Code would discard", () => {
    // A settings file with a comment is thrown away wholesale, so its entries
    // are not in effect and reporting on them would be noise about dead config
    // the user already has a more important error for.
    const resolution = resolveSettings([
      {
        file: "/proj/.claude/settings.local.json",
        layer: "projectLocal",
        text: '{\n  // dead\n  "permissions": { "allow": ["Bash(x)", "Bash(x)"] }\n}',
      },
    ]);
    const out = permissionRules({
      discovery: {
        projectRoot: "/proj",
        workspaceTrust: { trusted: true },
        rootProvenance: { root: "/proj", source: "forced" },
        startedFrom: "/proj",
        home: "/home",
        settings: [],
        memory: [],
        mcp: [],
        claudeDirs: [],
      },
      resolution,
      memory: [],
      keys: resolution.keys,
      parsed: resolution.parsed,
    });
    expect(out).toEqual([]);
  });
});
