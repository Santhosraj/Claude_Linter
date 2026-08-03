import { describe, expect, it } from "vitest";

import { resolveSettings, shadowedKeys } from "../src/resolve/settings.js";
import type { LayerInput } from "../src/resolve/settings.js";

function layers(spec: Record<string, unknown>[]): LayerInput[] {
  const kinds = ["user", "projectShared", "projectLocal", "managedPolicy"] as const;
  return spec.map((value, i) => ({
    file: `/fake/${kinds[i]}.json`,
    layer: kinds[i]!,
    text: JSON.stringify(value, null, 2),
  }));
}

function byPath(keys: ReturnType<typeof resolveSettings>["keys"], path: string) {
  const k = keys.find((x) => x.path === path);
  if (!k) throw new Error(`no resolved key at ${path}. Have: ${keys.map((x) => x.path).join(", ")}`);
  return k;
}

describe("override keys", () => {
  it("higher precedence wins and lower layers are reported as dead", () => {
    const { keys } = resolveSettings(
      layers([{ model: "opus" }, { model: "sonnet" }]),
    );
    const model = byPath(keys, "model");
    expect(model.strategy).toBe("override");
    expect(model.effective).toBe("sonnet");
    expect(model.shadowed.map((s) => s.layer)).toEqual(["user"]);
  });

  it("enterprise managed policy outranks every other layer", () => {
    const { keys } = resolveSettings(
      layers([{ model: "a" }, { model: "b" }, { model: "c" }, { model: "policy" }]),
    );
    expect(byPath(keys, "model").effective).toBe("policy");
  });
});

describe("hooks are additive — the claim this whole tool rests on", () => {
  it("does NOT report a user hook as shadowed by a project hook", () => {
    const userHook = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "user-audit.sh" }] },
        ],
      },
    };
    const projectHook = {
      hooks: {
        PreToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: "project-fmt.sh" }] },
        ],
      },
    };

    const { keys } = resolveSettings(layers([userHook, projectHook]));
    const pre = byPath(keys, "hooks.PreToolUse");

    expect(pre.strategy).toBe("hooks");
    // Both layers' hooks are live.
    expect(Array.isArray(pre.effective)).toBe(true);
    expect(pre.effective as unknown[]).toHaveLength(2);
    // And critically: nothing is discarded.
    expect(pre.shadowed).toEqual([]);
    expect(shadowedKeys(keys)).toEqual([]);
  });

  it("keeps distinct events separate", () => {
    const { keys } = resolveSettings(
      layers([
        { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } },
        { hooks: { PostToolUse: [{ matcher: "Edit", hooks: [] }] } },
      ]),
    );
    expect(byPath(keys, "hooks.PreToolUse").contributions).toHaveLength(1);
    expect(byPath(keys, "hooks.PostToolUse").contributions).toHaveLength(1);
  });
});

describe("concat keys", () => {
  it("unions permission lists across layers without discarding any", () => {
    const { keys } = resolveSettings(
      layers([
        { permissions: { allow: ["Bash(git *)"] } },
        { permissions: { allow: ["Read(**)"], deny: ["Bash(rm *)"] } },
      ]),
    );
    const allow = byPath(keys, "permissions.allow");
    expect(allow.strategy).toBe("concat");
    expect(allow.effective).toEqual(["Bash(git *)", "Read(**)"]);
    expect(allow.shadowed).toEqual([]);

    expect(byPath(keys, "permissions.deny").effective).toEqual(["Bash(rm *)"]);
  });

  it("still treats defaultMode as a scalar even though its siblings concat", () => {
    const { keys } = resolveSettings(
      layers([
        { permissions: { defaultMode: "acceptEdits", allow: ["A"] } },
        { permissions: { defaultMode: "plan", allow: ["B"] } },
      ]),
    );
    const mode = byPath(keys, "permissions.defaultMode");
    expect(mode.strategy).toBe("override");
    expect(mode.effective).toBe("plan");
    expect(mode.shadowed).toHaveLength(1);

    expect(byPath(keys, "permissions.allow").effective).toEqual(["A", "B"]);
  });
});

describe("deep-merge keys", () => {
  it("merges env per-key rather than replacing the whole object", () => {
    const { keys } = resolveSettings(
      layers([
        { env: { FOO: "1", SHARED: "user" } },
        { env: { BAR: "2", SHARED: "project" } },
      ]),
    );
    expect(byPath(keys, "env.FOO").effective).toBe("1");
    expect(byPath(keys, "env.BAR").effective).toBe("2");

    const shared = byPath(keys, "env.SHARED");
    expect(shared.effective).toBe("project");
    expect(shared.shadowed).toHaveLength(1);
  });
});

describe("robustness", () => {
  it("records a parse error instead of throwing on malformed JSON", () => {
    const { diagnostics, keys } = resolveSettings([
      { file: "/fake/bad.json", layer: "user", text: "{ not json" },
      { file: "/fake/ok.json", layer: "projectShared", text: '{ "model": "opus" }' },
    ]);
    expect(diagnostics.some((d) => d.ruleId === "json/parse-error")).toBe(true);
    // A broken layer must not take the good layers down with it.
    expect(byPath(keys, "model").effective).toBe("opus");
  });

  it("tolerates comments and trailing commas", () => {
    const { keys, diagnostics } = resolveSettings([
      {
        file: "/fake/local.json",
        layer: "projectLocal",
        text: `{
  // team decision, see ADR-014
  "model": "opus",
}`,
      },
    ]);
    expect(diagnostics).toEqual([]);
    expect(byPath(keys, "model").effective).toBe("opus");
  });

  it("attaches a real source position to each contribution", () => {
    const { keys } = resolveSettings([
      {
        file: "/fake/user.json",
        layer: "user",
        text: '{\n  "theme": "dark",\n  "model": "opus"\n}',
      },
    ]);
    const pos = byPath(keys, "model").contributions[0]?.position;
    expect(pos?.line).toBe(3);
  });
});
