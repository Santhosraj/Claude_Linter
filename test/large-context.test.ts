import { describe, expect, it } from "vitest";

import { budgetDiagnostics, type BudgetReport } from "../src/tokens/budget.js";

/**
 * `memory/large-always-loaded`.
 *
 * Running cclint over a real project reported `✓ No issues found` while a
 * 16,274-token CLAUDE.md was being paid for on every turn — the number sat in a
 * separate budget block below the green checkmark. "Context you're paying for on
 * every turn without realising it" is the tool's own headline pitch, and it was
 * the one thing the findings list stayed silent about.
 *
 * It is `info`/heuristic on purpose. A threshold is a judgment, a large CLAUDE.md
 * can be deliberate, and `error` in this project means "provable from the bytes".
 */

function report(over: Partial<BudgetReport> = {}): BudgetReport {
  return {
    entries: [
      {
        label: "project CLAUDE.md",
        file: "/p/CLAUDE.md",
        loadClass: "always",
        tokens: 16_274,
        mode: "estimated",
      },
    ],
    alwaysLoaded: 16_274,
    metadataOnly: 0,
    onDemand: 0,
    perTurnTotal: 16_274,
    contextWindow: 1_000_000,
    ...over,
  };
}

describe("large always-loaded context", () => {
  it("reports the per-turn cost and what share of the window it takes", () => {
    const [d] = budgetDiagnostics(report(), "/p");
    expect(d?.ruleId).toBe("memory/large-always-loaded");
    expect(d?.message).toContain("16,274");
    expect(d?.message).toContain("every turn");
    expect(d?.message).toContain("1.6%");
  });

  it("stays info, so it never breaks a build on a judgment call", () => {
    const [d] = budgetDiagnostics(report(), "/p");
    expect(d?.severity).toBe("info");
    expect(d?.heuristic).toBe(true);
  });

  it("says nothing about an ordinary CLAUDE.md", () => {
    // The precision lever. A thorough CLAUDE.md runs to hundreds of tokens; if
    // this fires there, the rule is noise and gets ignored — or switched off,
    // taking the real cases with it.
    expect(
      budgetDiagnostics(
        report({
          alwaysLoaded: 900,
          entries: [
            {
              label: "project CLAUDE.md",
              file: "/p/CLAUDE.md",
              loadClass: "always",
              tokens: 900,
              mode: "estimated",
            },
          ],
        }),
        "/p",
      ),
    ).toEqual([]);
  });

  it("counts only always-loaded content, not on-demand", () => {
    // A nested CLAUDE.md or a skill body costs nothing until used. Summing it
    // here would produce the inflated number this whole module exists to avoid.
    const r = report({
      alwaysLoaded: 400,
      onDemand: 50_000,
      entries: [
        {
          label: "project CLAUDE.md",
          file: "/p/CLAUDE.md",
          loadClass: "always",
          tokens: 400,
          mode: "estimated",
        },
        {
          label: "nested",
          file: "/p/sub/CLAUDE.md",
          loadClass: "onDemand",
          tokens: 50_000,
          mode: "estimated",
        },
      ],
    });
    expect(budgetDiagnostics(r, "/p")).toEqual([]);
  });

  it("marks estimated counts with ~ and drops it when counts are exact", () => {
    const estimated = budgetDiagnostics(report(), "/p")[0];
    expect(estimated?.message).toContain("~");

    const exact = budgetDiagnostics(
      report({
        entries: [
          {
            label: "project CLAUDE.md",
            file: "/p/CLAUDE.md",
            loadClass: "always",
            tokens: 16_274,
            mode: "exact",
          },
        ],
      }),
      "/p",
    )[0];
    expect(exact?.message).not.toContain("~");
    expect(exact?.data?.["estimated"]).toBe(false);
  });

  it("names the biggest contributors, so the finding is actionable", () => {
    const r = report({
      alwaysLoaded: 20_000,
      entries: [
        { label: "a", file: "/p/CLAUDE.md", loadClass: "always", tokens: 4_000, mode: "estimated" },
        { label: "b", file: "/p/big.md", loadClass: "always", tokens: 16_000, mode: "estimated" },
      ],
    });
    const [d] = budgetDiagnostics(r, "/p");
    // Largest first — "which file do I look at" is the only question here.
    expect(d?.detail?.[0]).toContain("big.md");
    expect(d?.file).toBe("/p/big.md");
  });
});
