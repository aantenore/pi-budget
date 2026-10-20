import { describe, expect, it } from "vitest";
import { totalsFromEntries } from "../src/entries.js";
import {
  assistantEntry,
  branchSummaryEntry,
  compactionEntry,
  toolResultEntry,
  usage,
  usageEntry,
  userEntry,
} from "./helpers/entries.js";

describe("totalsFromEntries", () => {
  it("returns zeros for no entries", () => {
    expect(totalsFromEntries([])).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });

  it("sums assistant, tool-result, usage-kind, compaction and branch-summary usage", () => {
    const totals = totalsFromEntries([
      userEntry(),
      assistantEntry(usage({ input: 100, output: 50, cost: 0.01 })),
      toolResultEntry(usage({ input: 10, output: 5, cost: 0.001 })),
      usageEntry(usage({ cacheRead: 1000, cacheWrite: 200, cost: 0.002 })),
      compactionEntry(usage({ input: 300, output: 30, cost: 0.003 })),
      branchSummaryEntry(usage({ input: 40, output: 4, cost: 0.004 })),
    ]);
    expect(totals.input).toBe(450);
    expect(totals.output).toBe(89);
    expect(totals.cacheRead).toBe(1000);
    expect(totals.cacheWrite).toBe(200);
    expect(totals.cost).toBeCloseTo(0.02, 10);
  });

  it("ignores entries without usage and other entry types", () => {
    const totals = totalsFromEntries([
      toolResultEntry(),
      compactionEntry(),
      branchSummaryEntry(),
      { type: "custom", usage: usage({ input: 999, cost: 9 }) },
      { type: "message", message: { role: "user", usage: usage({ input: 999 }) } },
      { type: "message", message: "not an object" },
    ]);
    expect(totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });

  it("tolerates malformed usage values", () => {
    const totals = totalsFromEntries([
      { type: "message", message: { role: "assistant", usage: { input: "x", output: NaN, cost: {} } } },
      { type: "usage", usage: null },
    ]);
    expect(totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });
});
