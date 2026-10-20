import type { AgentEvent, AgentLoopConfig, FinishTurn } from "@earendil-works/pi-agent-core";
import { normalizeConfig } from "./config.js";
import { exceededReason } from "./messages.js";
import { BudgetTracker } from "./tracker.js";
import type { BudgetConfig, Crossing } from "./types.js";

export interface BudgetHooksOptions {
  /** Called for every warn / exceed crossing, once per limit. Use it to log, notify, or call `agent.abort()`. */
  onCrossing?: (crossing: Crossing) => void;
  /** Clock override (milliseconds), mainly for tests. */
  clock?: () => number;
}

export interface BudgetHooks {
  tracker: BudgetTracker;
  /** Ends the run once a limit is exceeded and `onExceed` is `stop`. */
  finishTurn: FinishTurn;
  /** Blocks tool calls once a limit is exceeded and `onExceed` is `stop`; counts allowed calls. */
  beforeToolCall: NonNullable<AgentLoopConfig["beforeToolCall"]>;
  /** Feed every agent event here (`agent.subscribe(hooks.observe)`). */
  observe: (event: AgentEvent) => void;
}

/**
 * Budget enforcement for apps built on `@earendil-works/pi-agent-core`.
 *
 * ```ts
 * const budget = budgetHooks({ limits: { usd: 2, turns: 30 } });
 * const agent = new Agent({ ...options, finishTurn: budget.finishTurn, beforeToolCall: budget.beforeToolCall });
 * agent.subscribe(budget.observe);
 * ```
 *
 * Wall time (`minutes`) is checked at turn boundaries and before tool calls; this helper has no
 * timer. Session-scoped limits (usd, tokens) accumulate for the lifetime of the returned tracker.
 */
export function budgetHooks(config: Partial<BudgetConfig> = {}, options: BudgetHooksOptions = {}): BudgetHooks {
  const tracker = new BudgetTracker(normalizeConfig(config), options.clock);
  const emit = (crossings: Crossing[]) => {
    for (const c of crossings) options.onCrossing?.(c);
  };
  const stopping = () => tracker.mode === "stop" && tracker.isExceeded();

  // Messages already counted, so finishTurn (runs before the turn_end event) and observe never double count.
  const counted = new WeakSet<object>();
  const ingestTurn = (turn: { message: unknown; toolResults: readonly { usage?: unknown }[] }) => {
    const message = turn.message;
    if (typeof message !== "object" || message === null || counted.has(message)) return;
    counted.add(message);
    const usage = (message as { usage?: unknown }).usage;
    if (usage) emit(tracker.addUsage(usage as Parameters<BudgetTracker["addUsage"]>[0]));
    for (const result of turn.toolResults) {
      if (result.usage) emit(tracker.addUsage(result.usage as Parameters<BudgetTracker["addUsage"]>[0]));
    }
    emit(tracker.recordTurn());
  };

  return {
    tracker,

    finishTurn: (turn) => {
      ingestTurn(turn);
      emit(tracker.checkTime());
      return stopping() ? { action: "end" } : undefined;
    },

    beforeToolCall: async () => {
      emit(tracker.checkTime());
      if (stopping()) {
        return { block: true, reason: exceededReason(tracker.exceededLimits()), terminate: true };
      }
      emit(tracker.recordToolCall());
      return undefined;
    },

    observe: (event) => {
      switch (event.type) {
        case "agent_start":
          emit(tracker.startRun());
          break;
        case "turn_end":
          ingestTurn({ message: event.message, toolResults: event.toolResults });
          break;
        case "agent_end":
          tracker.endRun();
          break;
      }
    },
  };
}
