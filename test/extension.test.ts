import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantEntry, compactionEntry, toolResultEntry, usage } from "./helpers/entries.js";
import { createHarness, type Harness, type HarnessOptions } from "./helpers/fake-pi.js";

let root: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-budget-ext-"));
  project = join(root, "project");
  mkdirSync(project);
  // Isolate from the developer's real ~/.pi/budget.json and PI_BUDGET_* variables.
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("PI_BUDGET_")) vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const make = (options: HarnessOptions = {}): Harness => createHarness({ cwd: project, ...options });

/** Run one full turn: persist an assistant entry, then dispatch turn_start / turn_end. */
async function turn(h: Harness, cost: number, extra: Record<string, unknown> = {}) {
  h.entries.push(assistantEntry(usage({ input: 100, output: 50, cost })));
  await h.emit("turn_start", { turnIndex: 0, timestamp: 0 });
  await h.emit("turn_end", { turnIndex: 0, message: {}, toolResults: [], ...extra });
}

const levels = (h: Harness, level: string) => h.notifications.filter((n) => n.level === level);

describe("registration", () => {
  it("registers the flags, the /budget command and the event handlers", () => {
    const h = make();
    expect(h.registeredFlags).toEqual([
      "budget-usd",
      "budget-tokens",
      "budget-turns",
      "budget-tool-calls",
      "budget-minutes",
      "budget-on-exceed",
    ]);
    expect(h.commands.has("budget")).toBe(true);
    for (const event of ["session_start", "agent_start", "turn_end", "tool_call", "agent_settled", "session_shutdown"]) {
      expect(h.handlerCount(event)).toBeGreaterThan(0);
    }
  });

  it("does nothing without limits", async () => {
    const h = make();
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    await turn(h, 100);
    expect(await h.emit("tool_call", { toolName: "bash", toolCallId: "1", input: {} })).toBeUndefined();
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.notifications).toEqual([]);
    expect(h.lastStatus()).toBeUndefined();
  });
});

describe("usd limit in stop mode", () => {
  it("warns, then aborts, blocks tools, audits and updates the status", async () => {
    const h = make({ flags: { "budget-usd": "1" } });
    await h.emit("session_start", { reason: "startup" });
    expect(h.lastStatus()).toBe("$0.00/$1.00");
    await h.emit("agent_start");

    await turn(h, 0.5);
    expect(h.notifications).toEqual([]);
    expect(h.lastStatus()).toBe("$0.50/$1.00");

    await turn(h, 0.4); // 0.9 -> warn
    expect(levels(h, "warning")).toHaveLength(1);
    expect(levels(h, "warning")[0]!.message).toMatch(/approaching usd limit/);
    expect(h.abort).not.toHaveBeenCalled();
    expect(await h.emit("tool_call", { toolName: "bash", toolCallId: "a", input: {} })).toBeUndefined();

    await turn(h, 0.3); // 1.2 -> exceed
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(levels(h, "error")).toHaveLength(1);
    expect(levels(h, "error")[0]!.message).toMatch(/reached usd limit/);
    expect(h.lastStatus()).toBe("$1.20/$1.00!");

    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.type).toBe("pi-budget");
    expect(h.appended[0]!.data).toMatchObject({ limit: "usd", max: 1 });
    expect(h.appended[0]!.data.used).toBeCloseTo(1.2);
    expect(Number.isNaN(Date.parse(h.appended[0]!.data.at))).toBe(false);

    const blocked = await h.emit("tool_call", { toolName: "bash", toolCallId: "b", input: {} });
    expect(blocked).toMatchObject({ block: true, terminate: true });
    expect(blocked.reason).toMatch(/Budget exceeded \(usd \$1\.20\/\$1\.00\)/);

    await turn(h, 0.1); // further turns neither re-abort nor re-audit
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.appended).toHaveLength(1);
  });

  it("refuses a new run in an exhausted session without a second audit entry", async () => {
    const h = make({ flags: { "budget-usd": "1" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    await turn(h, 1.5);
    expect(h.abort).toHaveBeenCalledTimes(1);
    await h.emit("agent_settled", { aborted: true });

    await h.emit("agent_start");
    expect(h.abort).toHaveBeenCalledTimes(2);
    expect(h.notifications.at(-1)!.message).toMatch(/already exhausted/);
    expect(h.appended).toHaveLength(1);
    expect(await h.emit("tool_call", { toolName: "bash", toolCallId: "c", input: {} })).toMatchObject({ block: true });
  });

  it("reconstructs session totals from entries on session_start (resume)", async () => {
    const h = make({
      flags: { "budget-usd": "1" },
      entries: [
        assistantEntry(usage({ cost: 0.5 })),
        toolResultEntry(usage({ cost: 0.2 })),
        compactionEntry(usage({ cost: 0.15 })),
      ],
    });
    await h.emit("session_start", { reason: "resume" });
    expect(h.lastStatus()).toBe("$0.85/$1.00");
    expect(levels(h, "warning")).toHaveLength(1);
    expect(h.appended).toEqual([]);
  });

  it("counts compaction usage when session_compact fires", async () => {
    const h = make({ flags: { "budget-usd": "1" } });
    await h.emit("session_start", { reason: "startup" });
    h.entries.push(compactionEntry(usage({ cost: 1.1 })));
    await h.emit("session_compact", {});
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.appended).toHaveLength(1);
  });

  it("warns once when the model reports no cost", async () => {
    const h = make({ flags: { "budget-usd": "1" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    await turn(h, 0);
    await turn(h, 0);
    const notes = h.notifications.filter((n) => /\$0 cost/.test(n.message));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.level).toBe("warning");
  });
});

describe("warn mode", () => {
  it("notifies but never aborts, blocks or audits", async () => {
    const h = make({ flags: { "budget-usd": "1", "budget-on-exceed": "warn" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    await turn(h, 1.5);
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.appended).toEqual([]);
    expect(levels(h, "error")).toEqual([]);
    expect(levels(h, "warning")).toHaveLength(1);
    expect(levels(h, "warning")[0]!.message).toMatch(/reached usd limit/);
    expect(await h.emit("tool_call", { toolName: "bash", toolCallId: "1", input: {} })).toBeUndefined();
    await h.emit("agent_settled", { aborted: false });
    await h.emit("agent_start");
    expect(h.abort).not.toHaveBeenCalled();
  });
});

describe("per-run limits", () => {
  it("aborts at the turn limit and resets on the next run", async () => {
    const h = make({ flags: { "budget-turns": "2" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    await turn(h, 0);
    expect(h.abort).not.toHaveBeenCalled();
    await turn(h, 0);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.appended[0]!.data).toMatchObject({ limit: "turns", used: 2, max: 2 });
    await turn(h, 0); // Pi still dispatches turn_end for the turn the abort cancelled
    expect(h.lastStatus()).toBe("2/2 turns!");
    await h.emit("agent_settled", { aborted: true });

    await h.emit("agent_start");
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.lastStatus()).toBe("0/2 turns");
    expect(await h.emit("tool_call", { toolName: "bash", toolCallId: "1", input: {} })).toBeUndefined();
    await turn(h, 0);
    expect(h.abort).toHaveBeenCalledTimes(1);
  });

  it("lets the last allowed tool call run, blocks the next, and aborts at turn end", async () => {
    const h = make({ flags: { "budget-tool-calls": "2" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    expect(await h.emit("tool_call", { toolName: "read", toolCallId: "1", input: {} })).toBeUndefined();
    expect(await h.emit("tool_call", { toolName: "read", toolCallId: "2", input: {} })).toBeUndefined();
    expect(h.abort).not.toHaveBeenCalled(); // the allowed call keeps running
    expect(levels(h, "error")).toHaveLength(1);
    const blocked = await h.emit("tool_call", { toolName: "read", toolCallId: "3", input: {} });
    expect(blocked).toMatchObject({ block: true });
    expect(blocked.reason).toMatch(/tool-calls 2\/2 tools/);
    await turn(h, 0);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.appended).toHaveLength(1);
  });
});

describe("wall time", () => {
  it("starts on agent_start, warns, aborts at the limit and clears on agent_settled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = make({ flags: { "budget-minutes": "1" } });
    await h.emit("session_start", { reason: "startup" });
    expect(vi.getTimerCount()).toBe(0); // nothing armed by the factory or session_start

    await h.emit("agent_start");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(47_000);
    expect(h.notifications).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(levels(h, "warning")).toHaveLength(1);
    expect(h.abort).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(11_000);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(levels(h, "error")[0]!.message).toMatch(/reached minutes limit/);
    expect(h.appended[0]!.data).toMatchObject({ limit: "minutes", max: 1 });
    expect(vi.getTimerCount()).toBe(0);

    await h.emit("agent_settled", { aborted: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.abort).toHaveBeenCalledTimes(1);
  });

  it("clears the timer on agent_settled and session_shutdown", async () => {
    vi.useFakeTimers();
    const h = make({ flags: { "budget-minutes": "5" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    expect(vi.getTimerCount()).toBe(1);
    await h.emit("agent_settled", { aborted: false });
    expect(vi.getTimerCount()).toBe(0);

    await h.emit("agent_start");
    expect(vi.getTimerCount()).toBe(1);
    await h.emit("session_shutdown", { reason: "quit" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.abort).not.toHaveBeenCalled();
  });

  it("does not abort in warn mode", async () => {
    vi.useFakeTimers();
    const h = make({ flags: { "budget-minutes": "1", "budget-on-exceed": "warn" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(h.abort).not.toHaveBeenCalled();
    expect(levels(h, "warning").length).toBeGreaterThanOrEqual(2);
  });
});

describe("no UI", () => {
  it("skips notify and setStatus and writes to stderr instead", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = make({ hasUI: false, flags: { "budget-usd": "1" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    await turn(h, 2);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.notifications).toEqual([]);
    expect(h.statuses).toEqual([]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("reached usd limit"));
  });
});

describe("/budget command", () => {
  it("shows usage versus limits", async () => {
    const h = make({ flags: { "budget-usd": "2", "budget-turns": "10" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    await turn(h, 0.5);
    await h.command("");
    const text = h.notifications.at(-1)!.message;
    expect(text).toContain("on exceed: stop");
    expect(text).toMatch(/usd\s+\$0\.50\/\$2\.00\s+\(per session\)/);
    expect(text).toMatch(/turns\s+1\/10 turns\s+\(per run\)/);
  });

  it("explains how to set limits when none exist", async () => {
    const h = make();
    await h.emit("session_start", { reason: "startup" });
    await h.command("");
    expect(h.notifications.at(-1)!.message).toMatch(/No limits set/);
  });

  it("adjusts and removes limits for the current session", async () => {
    const h = make({ flags: { "budget-usd": "1" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    await turn(h, 0.5);

    await h.command("set usd 5");
    expect(h.lastStatus()).toBe("$0.50/$5.00");
    await h.command("set tool-calls 3");
    expect(h.lastStatus()).toBe("$0.50/$5.00 · 0/3 tools");
    await h.command("set usd off");
    expect(h.lastStatus()).toBe("0/3 tools");
    await h.command("set toolCalls off");
    expect(h.lastStatus()).toBeUndefined();
    expect(h.abort).not.toHaveBeenCalled();
  });

  it("enforces a limit lowered below current usage", async () => {
    const h = make({ flags: { "budget-usd": "5" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    await turn(h, 2);
    h.setIdle(false);
    await h.command("set usd 1");
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.appended).toHaveLength(1);
  });

  it("re-arms enforcement after a limit is raised", async () => {
    const h = make({ flags: { "budget-usd": "1" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    await turn(h, 1.5);
    expect(h.abort).toHaveBeenCalledTimes(1);
    await h.command("set usd 3");
    expect(await h.emit("tool_call", { toolName: "bash", toolCallId: "1", input: {} })).toBeUndefined();
    await turn(h, 2);
    expect(h.abort).toHaveBeenCalledTimes(2);
  });

  it("rejects bad input without changing limits", async () => {
    const h = make({ flags: { "budget-usd": "1" } });
    await h.emit("session_start", { reason: "startup" });
    await h.command("set usd -3");
    expect(h.notifications.at(-1)).toMatchObject({ level: "error" });
    await h.command("set nonsense 3");
    expect(h.notifications.at(-1)!.message).toMatch(/Unknown limit/);
    await h.command("bogus");
    expect(h.notifications.at(-1)!.message).toMatch(/Usage:/);
    expect(h.lastStatus()).toBe("$0.00/$1.00");
  });
});

describe("failure handling", () => {
  it("reports an invalid configuration and disables enforcement", async () => {
    const h = make({ flags: { "budget-usd": "-1" } });
    await h.emit("session_start", { reason: "startup" });
    expect(levels(h, "error")).toHaveLength(1);
    expect(levels(h, "error")[0]!.message).toMatch(/--budget-usd.*disabled/);
    await h.emit("agent_start");
    await turn(h, 100);
    expect(h.abort).not.toHaveBeenCalled();
    expect(await h.emit("tool_call", { toolName: "bash", toolCallId: "1", input: {} })).toBeUndefined();
  });

  it("catches handler errors and reports each distinct error once", async () => {
    const h = make({ flags: { "budget-usd": "1" } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("agent_start");
    h.ctx.sessionManager.getEntries = () => {
      throw new Error("boom");
    };
    await expect(h.emit("turn_end", { turnIndex: 0, message: {}, toolResults: [] })).resolves.toBeUndefined();
    await expect(h.emit("turn_end", { turnIndex: 1, message: {}, toolResults: [] })).resolves.toBeUndefined();
    const errors = levels(h, "error").filter((n) => /internal error in turn_end: boom/.test(n.message));
    expect(errors).toHaveLength(1);
    // The host keeps working: tools are not blocked after a failed accounting step.
    expect(await h.emit("tool_call", { toolName: "bash", toolCallId: "1", input: {} })).toBeUndefined();
  });
});
