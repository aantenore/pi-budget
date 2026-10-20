import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ConfigReport, DEFAULT_CONFIG, FLAG_NAMES, type FlagValues, loadConfigReport } from "../src/config.js";
import { totalsFromEntries } from "../src/entries.js";
import { formatLimit, formatMax } from "../src/format.js";
import { kebabName, LIMIT_SCOPE, parseLimitValue, resolveLimitKey } from "../src/limits.js";
import { describeCrossing, exceededReason } from "../src/messages.js";
import { BudgetTracker, countsAsTurn } from "../src/tracker.js";
import type { Crossing } from "../src/types.js";

const STATUS_KEY = "budget";
const AUDIT_TYPE = "pi-budget";
/** Longest delay setTimeout accepts; longer waits are re-armed when the timer fires. */
const MAX_TIMER_MS = 2_147_483_647;

const FLAG_DESCRIPTIONS: Record<keyof FlagValues, string> = {
  usd: "Stop the session after this much spend in USD (cumulative per session)",
  tokens: "Stop the session after this many total tokens (cumulative per session)",
  turns: "Stop an agent run after this many turns",
  toolCalls: "Stop an agent run after this many tool calls",
  minutes: "Stop an agent run after this many minutes of wall time",
  onExceed: "What to do when a budget limit is reached: stop (default) or warn",
};

const USAGE = "Usage: /budget | /budget set <usd|tokens|input-tokens|output-tokens|turns|tool-calls|minutes> <value|off>";

export default function budget(pi: ExtensionAPI): void {
  for (const key of Object.keys(FLAG_NAMES) as (keyof FlagValues)[]) {
    pi.registerFlag(FLAG_NAMES[key], { type: "string", description: FLAG_DESCRIPTIONS[key] });
  }

  // No limits until session_start loads the configuration, so early events are no-ops.
  let tracker = new BudgetTracker(DEFAULT_CONFIG);
  let latestCtx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortedThisRun = false;
  let unpricedNoted = false;
  /** Set when a configuration source could not be loaded and stop mode applies: work is refused until it is fixed. */
  let configBlock: string | undefined;
  const reported = new Set<string>();

  function say(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.error(`[pi-budget] ${message}`);
  }

  function reportOnce(where: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const key = `${where}:${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    const text = `pi-budget: internal error in ${where}: ${message}`;
    try {
      if (latestCtx?.hasUI) latestCtx.ui.notify(text, "error");
      else console.error(text);
    } catch {
      // Reporting must never throw into the host.
    }
  }

  function guard<E, R>(where: string, fn: (event: E, ctx: ExtensionContext) => R, onError?: () => R | undefined) {
    return (event: E, ctx: ExtensionContext): R | undefined => {
      latestCtx = ctx;
      try {
        return fn(event, ctx);
      } catch (error) {
        reportOnce(where, error);
        return onError?.();
      }
    };
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, tracker.hasLimits() ? tracker.format() : undefined);
  }

  function readFlags(): FlagValues {
    const flags: FlagValues = {};
    for (const key of Object.keys(FLAG_NAMES) as (keyof FlagValues)[]) {
      flags[key] = pi.getFlag(FLAG_NAMES[key]);
    }
    return flags;
  }

  function handleCrossings(ctx: ExtensionContext, crossings: Crossing[], audit = true): void {
    for (const c of crossings) {
      if (c.type === "warn") {
        say(ctx, `Budget: ${describeCrossing(c)}.`, "warning");
      } else if (tracker.mode === "stop") {
        say(ctx, `Budget: ${describeCrossing(c)}. Stopping the run.`, "error");
        if (audit) pi.appendEntry(AUDIT_TYPE, { limit: c.limit, used: c.used, max: c.max, at: new Date().toISOString() });
      } else {
        say(ctx, `Budget: ${describeCrossing(c)}.`, "warning");
      }
    }
  }

  /** Abort the run once, when stop mode is on and a limit is exceeded. */
  function enforce(ctx: ExtensionContext): void {
    if (tracker.mode === "stop" && !abortedThisRun && tracker.isExceeded()) {
      abortedThisRun = true;
      ctx.abort();
    }
  }

  function syncFromSession(ctx: ExtensionContext, audit = true): void {
    const crossings = tracker.syncSession(totalsFromEntries(ctx.sessionManager.getEntries()));
    handleCrossings(ctx, crossings, audit);
    if (!unpricedNoted && tracker.looksUnpriced()) {
      unpricedNoted = true;
      say(
        ctx,
        "Budget: a usd limit is set but the model reported $0 cost (local or unpriced model?). Use a token limit instead.",
        "warning",
      );
    }
  }

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function armTimer(): void {
    clearTimer();
    const ms = tracker.msUntilNextTimeThreshold();
    if (ms === undefined) return;
    timer = setTimeout(onTimer, Math.min(ms, MAX_TIMER_MS));
    timer.unref?.();
  }

  function onTimer(): void {
    timer = undefined;
    const ctx = latestCtx;
    if (!ctx) return;
    try {
      handleCrossings(ctx, tracker.checkTime());
      enforce(ctx);
      updateStatus(ctx);
    } catch (error) {
      reportOnce("wall-time timer", error);
    }
    armTimer();
  }

  pi.on(
    "session_start",
    guard("session_start", (_event, ctx) => {
      clearTimer();
      abortedThisRun = false;
      unpricedNoted = false;
      configBlock = undefined;
      let report: ConfigReport;
      try {
        report = loadConfigReport({ cwd: ctx.cwd, flags: readFlags() });
      } catch (error) {
        report = { config: DEFAULT_CONFIG, problems: [(error as Error).message], unusable: true };
      }
      tracker = new BudgetTracker(report.config);
      if (report.problems.length > 0) {
        const detail = report.problems.map((p) => `pi-budget: ${p}`).join("\n");
        if (report.unusable && report.config.onExceed === "stop") {
          configBlock = `The budget configuration could not be loaded (${report.problems.join("; ")}). Fix it and reload.`;
          say(ctx, `${detail}\nBlocking runs and tool calls until this is fixed.`, "error");
        } else {
          say(ctx, `${detail}\nThe invalid settings were ignored; the rest of the configuration applies.`, "error");
        }
      }
      const crossings = tracker.loadSession(totalsFromEntries(ctx.sessionManager.getEntries()));
      handleCrossings(ctx, crossings, false);
      updateStatus(ctx);
    }),
  );

  pi.on(
    "agent_start",
    guard("agent_start", (_event, ctx) => {
      // Pi emits agent_start again for every continuation inside one run (auto-retry, compaction,
      // queued messages, agent_before_settle); only the first start begins a run.
      if (tracker.running) return;
      abortedThisRun = false;
      handleCrossings(ctx, tracker.startRun());
      armTimer();
      if (configBlock !== undefined) {
        say(ctx, configBlock, "error");
        abortedThisRun = true;
        ctx.abort();
      } else if (tracker.mode === "stop" && tracker.isExceeded()) {
        say(
          ctx,
          `Budget already exhausted (${tracker.format()}). Raise it with /budget set <limit> <value>.`,
          "error",
        );
        enforce(ctx);
      }
      updateStatus(ctx);
    }),
  );

  pi.on(
    "turn_end",
    guard("turn_end", (event: { message?: unknown }, ctx) => {
      syncFromSession(ctx);
      // Pi still dispatches a turn_end for the turn that the abort cancelled, and for turns that
      // failed or were aborted; none of them is a completed turn.
      if (!abortedThisRun && countsAsTurn(event.message)) handleCrossings(ctx, tracker.recordTurn());
      enforce(ctx);
      updateStatus(ctx);
    }),
  );

  pi.on(
    "tool_call",
    guard(
      "tool_call",
      (_event, ctx) => {
        if (configBlock !== undefined) return { block: true, reason: configBlock, terminate: true };
        // Totals are otherwise refreshed only at turn end; replace them from the entries so the
        // current turn's usage is already known before this call runs.
        syncFromSession(ctx);
        if (tracker.mode === "stop" && tracker.isExceeded()) {
          return { block: true, reason: exceededReason(tracker.exceededLimits()), terminate: true };
        }
        // Reaching the tool-call limit with this call lets it run; the run is aborted at turn end.
        handleCrossings(ctx, tracker.recordToolCall());
        updateStatus(ctx);
        return undefined;
      },
      // Fail closed: when enforcement itself breaks in stop mode, do not let the tool run unchecked.
      () =>
        tracker.mode === "stop" && tracker.hasLimits()
          ? {
              block: true,
              reason: "pi-budget could not verify the budget (internal error); tool call blocked.",
              terminate: true,
            }
          : undefined,
    ),
  );

  const resync = (where: string) =>
    guard(where, (_event: unknown, ctx: ExtensionContext) => {
      syncFromSession(ctx);
      enforce(ctx);
      updateStatus(ctx);
    });
  pi.on("session_compact", resync("session_compact"));
  pi.on("session_tree", resync("session_tree"));

  pi.on(
    "agent_settled",
    guard("agent_settled", (_event, ctx) => {
      clearTimer();
      tracker.endRun();
      updateStatus(ctx);
    }),
  );

  pi.on(
    "session_shutdown",
    guard("session_shutdown", () => {
      clearTimer();
      tracker.endRun();
    }),
  );

  function describeBudget(): string {
    const states = tracker.state();
    const header = `Budget (on exceed: ${tracker.mode})${configBlock === undefined ? "" : `\nBLOCKED: ${configBlock}`}`;
    if (states.length === 0) {
      return `${header}\nNo limits set. Use --budget-usd / --budget-turns / ..., a budget.json file, or /budget set <limit> <value>.`;
    }
    const lines = states.map((s) => {
      const tag = s.status === "exceeded" ? "  EXCEEDED" : s.status === "warn" ? "  warning" : "";
      return `  ${kebabName(s.limit).padEnd(14)}${formatLimit(s.limit, s.used, s.max)}  (per ${LIMIT_SCOPE[s.limit]})${tag}`;
    });
    return [header, ...lines].join("\n");
  }

  pi.registerCommand("budget", {
    description: "Show budget usage, or adjust a limit: /budget set <limit> <value|off>",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      try {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0 || parts[0] === "status") {
          syncFromSession(ctx);
          say(ctx, describeBudget(), "info");
          updateStatus(ctx);
          return;
        }
        if (parts[0] !== "set" || parts.length !== 3) {
          say(ctx, USAGE, "error");
          return;
        }
        const key = resolveLimitKey(parts[1]!);
        if (!key) {
          say(ctx, `Unknown limit "${parts[1]}". ${USAGE}`, "error");
          return;
        }
        const raw = parts[2]!;
        let value: number | undefined;
        if (["off", "none", "unlimited"].includes(raw.toLowerCase())) {
          value = undefined;
        } else {
          try {
            value = parseLimitValue(key, raw);
          } catch (error) {
            say(ctx, (error as Error).message, "error");
            return;
          }
        }
        abortedThisRun = false;
        const crossings = tracker.setLimit(key, value);
        say(
          ctx,
          value === undefined ? `Removed ${kebabName(key)} limit.` : `Set ${kebabName(key)} limit to ${formatMax(key, value)}.`,
          "info",
        );
        handleCrossings(ctx, crossings);
        if (!ctx.isIdle()) enforce(ctx);
        armTimer();
        updateStatus(ctx);
      } catch (error) {
        reportOnce("/budget", error);
      }
    },
  });
}
