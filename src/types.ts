/** Limits that can be enforced. Every field is optional; unset means "no limit". */
export interface BudgetLimits {
  /** Cumulative cost in USD, per session. */
  usd?: number;
  /** Cumulative input + output + cache read + cache write tokens, per session. */
  tokens?: number;
  /** Cumulative input-side tokens (input + cache read + cache write), per session. */
  inputTokens?: number;
  /** Cumulative output tokens, per session. */
  outputTokens?: number;
  /** Completed model turns, per agent run. */
  turns?: number;
  /** Tool calls, per agent run. */
  toolCalls?: number;
  /** Wall-clock minutes, per agent run. */
  minutes?: number;
}

export type LimitKey = keyof BudgetLimits;
export type LimitScope = "session" | "run";
export type OnExceed = "stop" | "warn";

export interface BudgetConfig {
  limits: BudgetLimits;
  /** Fraction of a limit (0 < warnAt <= 1) at which a warning is raised. */
  warnAt: number;
  /** `stop` ends the run when a limit is reached; `warn` only reports it. */
  onExceed: OnExceed;
}

/** Cumulative usage counters, in the same shape Pi uses for session totals. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Structural subset of a Pi `Usage` object. */
export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export type CrossingType = "warn" | "exceed";

/** A threshold that was crossed by the latest observation. */
export interface Crossing {
  type: CrossingType;
  limit: LimitKey;
  used: number;
  max: number;
}

export type LimitStatus = "ok" | "warn" | "exceeded";

export interface LimitState {
  limit: LimitKey;
  scope: LimitScope;
  used: number;
  max: number;
  status: LimitStatus;
}
