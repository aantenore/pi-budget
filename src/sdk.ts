import type { AgentEvent, AgentLoopConfig, FinishTurn } from "@earendil-works/pi-agent-core";
import { normalizeConfig } from "./config.js";
import { exceededReason } from "./messages.js";
import { BudgetTracker, countsAsTurn } from "./tracker.js";
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
  /**
   * Rejects the provider request when a limit is already exceeded and `onExceed` is `stop`, so an
   * exhausted budget never makes a paid request. pi-agent-core turns the rejection into an error
   * assistant message and ends the run without calling the provider.
   */
  prepareRequest: NonNullable<AgentLoopConfig["prepareRequest"]>;
  /** Feed every agent event here (`agent.subscribe(hooks.observe)`). */
  observe: (event: AgentEvent) => void;
}

/**
 * Budget enforcement for apps built on `@earendil-works/pi-agent-core`.
 *
 * ```ts
 * const budget = budgetHooks({ limits: { usd: 2, turns: 30 } });
 * const agent = new Agent({
 *   ...options,
 *   finishTurn: budget.finishTurn,
 *   beforeToolCall: budget.beforeToolCall,
 *   prepareRequest: budget.prepareRequest,
 * });
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

  // Messages whose usage is already counted, so message_end, finishTurn (runs before the turn_end
  // event) and turn_end never double count. Turns are deduplicated separately.
  const counted = new WeakSet<object>();
  const turnsCounted = new WeakSet<object>();
  const ingestUsage = (message: unknown) => {
    if (typeof message !== "object" || message === null || counted.has(message)) return;
    counted.add(message);
    const usage = (message as { usage?: unknown }).usage;
    if (usage) emit(tracker.addUsage(usage as Parameters<BudgetTracker["addUsage"]>[0]));
  };
  const ingestTurn = (turn: { message: unknown; toolResults: readonly unknown[] }) => {
    const message = turn.message;
    if (typeof message !== "object" || message === null || turnsCounted.has(message)) return;
    turnsCounted.add(message);
    ingestUsage(message);
    for (const result of turn.toolResults) ingestUsage(result);
    if (countsAsTurn(message)) emit(tracker.recordTurn());
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

    prepareRequest: () => {
      emit(tracker.checkTime());
      if (stopping()) throw new Error(exceededReason(tracker.exceededLimits()));
      return undefined;
    },

    observe: (event) => {
      switch (event.type) {
        case "agent_start":
          emit(tracker.startRun());
          break;
        case "message_end":
          ingestUsage(event.message);
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
