import { describe, expect, it } from "vitest";
import { formatCount, formatLimit, formatMinutes, formatUsd } from "../src/format.js";
import { BudgetTracker, countsAsTurn, emptyTotals } from "../src/tracker.js";
import type { BudgetConfig } from "../src/types.js";
import { usage } from "./helpers/entries.js";

const cfg = (partial: Partial<BudgetConfig> = {}): BudgetConfig => ({
  limits: {},
  warnAt: 0.8,
  onExceed: "stop",
  ...partial,
});

describe("BudgetTracker usd/token math", () => {
  it("accumulates cost and token variants", () => {
    const t = new BudgetTracker(cfg({ limits: { usd: 10, tokens: 1e6, inputTokens: 1e6, outputTokens: 1e6 } }));
    t.addUsage(usage({ input: 100, output: 40, cacheRead: 500, cacheWrite: 60, cost: 0.25 }));
    expect(t.used("usd")).toBeCloseTo(0.25);
    expect(t.used("tokens")).toBe(700);
    expect(t.used("inputTokens")).toBe(660);
    expect(t.used("outputTokens")).toBe(40);
  });

  it("warns once at warnAt and exceeds once at the limit", () => {
    const t = new BudgetTracker(cfg({ limits: { usd: 1 } }));
    expect(t.addUsage(usage({ cost: 0.5 }))).toEqual([]);
    expect(t.addUsage(usage({ cost: 0.3 }))).toEqual([{ type: "warn", limit: "usd", used: 0.8, max: 1 }]);
    expect(t.addUsage(usage({ cost: 0.05 }))).toEqual([]);
    const exceed = t.addUsage(usage({ cost: 0.2 }));
    expect(exceed).toHaveLength(1);
    expect(exceed[0]).toMatchObject({ type: "exceed", limit: "usd", max: 1 });
    expect(t.addUsage(usage({ cost: 1 }))).toEqual([]);
    expect(t.isExceeded()).toBe(true);
  });

  it("reports only exceed when one observation jumps past both thresholds", () => {
    const t = new BudgetTracker(cfg({ limits: { tokens: 100 } }));
    const crossings = t.addUsage(usage({ input: 150 }));
    expect(crossings.map((c) => c.type)).toEqual(["exceed"]);
    expect(t.addUsage(usage({ input: 1 }))).toEqual([]);
  });

  it("treats used === max as exceeded", () => {
    const t = new BudgetTracker(cfg({ limits: { turns: 2 } }));
    t.recordTurn();
    expect(t.recordTurn().map((c) => c.type)).toEqual(["exceed"]);
  });

  it("supports warnAt = 1 (exceed only)", () => {
    const t = new BudgetTracker(cfg({ limits: { turns: 4 }, warnAt: 1 }));
    expect(t.recordTurn().concat(t.recordTurn(), t.recordTurn())).toEqual([]);
    expect(t.recordTurn().map((c) => c.type)).toEqual(["exceed"]);
  });

  it("ignores unset limits", () => {
    const t = new BudgetTracker(cfg());
    expect(t.addUsage(usage({ input: 1e9, cost: 1e6 }))).toEqual([]);
    expect(t.hasLimits()).toBe(false);
    expect(t.isExceeded()).toBe(false);
    expect(t.format()).toBe("");
  });
});

describe("BudgetTracker scopes", () => {
  it("resets run-scoped counters on startRun and keeps session-scoped ones", () => {
    let now = 0;
    const t = new BudgetTracker(cfg({ limits: { usd: 10, turns: 3, toolCalls: 3, minutes: 10 } }), () => now);
    t.startRun();
    t.addUsage(usage({ cost: 2 }));
    t.recordTurn();
    t.recordToolCall();
    now = 120_000;
    expect(t.used("turns")).toBe(1);
    expect(t.used("toolCalls")).toBe(1);
    expect(t.used("minutes")).toBeCloseTo(2);
    t.endRun();
    now = 600_000;
    expect(t.used("turns")).toBe(0); // idle trackers do not report run counters
    expect(t.used("toolCalls")).toBe(0);
    expect(t.used("minutes")).toBe(0);

    t.startRun();
    expect(t.used("turns")).toBe(0);
    expect(t.used("toolCalls")).toBe(0);
    expect(t.used("minutes")).toBe(0);
    expect(t.used("usd")).toBe(2);
  });

  it("does not report an exceeded run limit set while idle after a run", () => {
    const t = new BudgetTracker(cfg({ limits: { turns: 5, toolCalls: 5 } }));
    t.startRun();
    for (let i = 0; i < 3; i++) {
      t.recordTurn();
      t.recordToolCall();
    }
    t.endRun();
    expect(t.setLimit("turns", 1)).toEqual([]);
    expect(t.setLimit("toolCalls", 2)).toEqual([]);
    expect(t.isExceeded()).toBe(false);
    expect(t.state().map((s) => s.status)).toEqual(["ok", "ok"]);
  });

  it("re-reports run-scoped crossings in a new run but not session-scoped ones", () => {
    const t = new BudgetTracker(cfg({ limits: { usd: 1, turns: 1 } }));
    t.startRun();
    t.addUsage(usage({ cost: 2 }));
    expect(t.recordTurn().map((c) => c.limit)).toEqual(["turns"]);
    expect(t.startRun().map((c) => c.limit)).toEqual([]);
    expect(t.recordTurn().map((c) => c.limit)).toEqual(["turns"]);
    expect(t.isExceeded()).toBe(true);
  });

  it("loadSession replaces totals and re-arms session crossings", () => {
    const t = new BudgetTracker(cfg({ limits: { usd: 1 } }));
    t.addUsage(usage({ cost: 2 }));
    const totals = { ...emptyTotals(), cost: 0.9 };
    expect(t.loadSession(totals).map((c) => c.type)).toEqual(["warn"]);
    expect(t.used("usd")).toBe(0.9);
  });

  it("syncSession replaces totals without re-reporting", () => {
    const t = new BudgetTracker(cfg({ limits: { usd: 1 } }));
    expect(t.syncSession({ ...emptyTotals(), cost: 1.5 }).map((c) => c.type)).toEqual(["exceed"]);
    expect(t.syncSession({ ...emptyTotals(), cost: 1.6 })).toEqual([]);
  });

  it("setLimit re-arms crossings for that limit only", () => {
    const t = new BudgetTracker(cfg({ limits: { usd: 1, tokens: 100 } }));
    t.addUsage(usage({ input: 200, cost: 2 }));
    expect(t.setLimit("usd", 5)).toEqual([]);
    expect(t.isExceeded()).toBe(true); // tokens still exceeded
    const crossings = t.setLimit("usd", 1.5);
    expect(crossings.map((c) => c.type)).toEqual(["exceed"]);
    t.setLimit("usd", undefined);
    expect(t.getLimits().usd).toBeUndefined();
  });
});

describe("BudgetTracker wall time", () => {
  it("reports time thresholds and the delay to the next one", () => {
    let now = 1_000;
    const t = new BudgetTracker(cfg({ limits: { minutes: 10 } }), () => now);
    expect(t.msUntilNextTimeThreshold()).toBeUndefined(); // no run yet
    t.startRun();
    expect(t.msUntilNextTimeThreshold()).toBe(8 * 60_000);
    now += 8 * 60_000;
    expect(t.checkTime().map((c) => c.type)).toEqual(["warn"]);
    expect(t.msUntilNextTimeThreshold()).toBe(2 * 60_000);
    now += 2 * 60_000;
    expect(t.checkTime().map((c) => c.type)).toEqual(["exceed"]);
    expect(t.msUntilNextTimeThreshold()).toBeUndefined();
    expect(t.checkTime()).toEqual([]);
  });
});

describe("BudgetTracker.looksUnpriced", () => {
  it("flags usd limits with tokens but zero cost", () => {
    const t = new BudgetTracker(cfg({ limits: { usd: 1 } }));
    expect(t.looksUnpriced()).toBe(false);
    t.addUsage(usage({ input: 10 }));
    expect(t.looksUnpriced()).toBe(true);
    t.addUsage(usage({ cost: 0.01 }));
    expect(t.looksUnpriced()).toBe(false);
  });
});

describe("formatting", () => {
  it("formats counts, usd and minutes", () => {
    expect(formatCount(950)).toBe("950");
    expect(formatCount(12_300)).toBe("12.3k");
    expect(formatCount(200_000)).toBe("200k");
    expect(formatCount(1_500_000)).toBe("1.5M");
    expect(formatUsd(0.12)).toBe("$0.12");
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(0.0034)).toBe("$0.0034");
    expect(formatMinutes(2)).toBe("2m");
    expect(formatMinutes(0.5)).toBe("0.5m");
    expect(formatMinutes(29.6)).toBe("30m");
    expect(formatLimit("toolCalls", 5, 50)).toBe("5/50 tools");
  });

  it("builds the compact status string", () => {
    let now = 0;
    const t = new BudgetTracker(
      cfg({ limits: { usd: 1, tokens: 200_000, turns: 20, minutes: 30 } }),
      () => now,
    );
    t.startRun();
    t.addUsage(usage({ input: 10_000, output: 2_300, cost: 0.12 }));
    for (let i = 0; i < 4; i++) t.recordTurn();
    now = 2 * 60_000;
    expect(t.format()).toBe("$0.12/$1.00 · 12.3k/200k tok · 4/20 turns · 2m/30m");
  });

  it("marks exceeded limits with a bang", () => {
    const t = new BudgetTracker(cfg({ limits: { usd: 1, turns: 5 } }));
    t.addUsage(usage({ cost: 1.2 }));
    expect(t.format()).toBe("$1.20/$1.00! · 0/5 turns");
  });
});

describe("countsAsTurn", () => {
  it("does not count aborted or errored turns", () => {
    expect(countsAsTurn({ stopReason: "stop" })).toBe(true);
    expect(countsAsTurn({ stopReason: "toolUse" })).toBe(true);
    expect(countsAsTurn({})).toBe(true);
    expect(countsAsTurn(undefined)).toBe(true);
    expect(countsAsTurn({ stopReason: "aborted" })).toBe(false);
    expect(countsAsTurn({ stopReason: "error" })).toBe(false);
  });
});
