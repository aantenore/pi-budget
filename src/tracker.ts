import { formatLimit } from "./format.js";
import { LIMIT_KEYS, LIMIT_SCOPE } from "./limits.js";
import type {
  BudgetConfig,
  BudgetLimits,
  Crossing,
  LimitKey,
  LimitState,
  LimitStatus,
  UsageLike,
  UsageTotals,
} from "./types.js";

export function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Add one usage object to running totals. Missing or non-finite fields count as 0. */
export function addUsage(totals: UsageTotals, usage: UsageLike): void {
  totals.input += num(usage.input);
  totals.output += num(usage.output);
  totals.cacheRead += num(usage.cacheRead);
  totals.cacheWrite += num(usage.cacheWrite);
  totals.cost += num(usage.cost?.total);
}

const MS_PER_MINUTE = 60_000;

/**
 * Pure budget accounting. Holds session-scoped usage and run-scoped counters, and reports
 * each warn / exceed threshold once. It never performs I/O and has no timers: callers feed it
 * observations and act on the returned {@link Crossing}s.
 *
 * A limit is exceeded when `used >= max`.
 */
export class BudgetTracker {
  private limits: BudgetLimits;
  private readonly warnAt: number;
  private readonly onExceed: BudgetConfig["onExceed"];
  private readonly clock: () => number;

  private totals: UsageTotals = emptyTotals();
  private turns = 0;
  private toolCalls = 0;
  private runStartedAt: number | undefined;
  private frozenElapsedMs = 0;

  private readonly warned = new Set<LimitKey>();
  private readonly exceededSeen = new Set<LimitKey>();

  constructor(config: BudgetConfig, clock: () => number = Date.now) {
    this.limits = { ...config.limits };
    this.warnAt = config.warnAt;
    this.onExceed = config.onExceed;
    this.clock = clock;
  }

  get mode(): BudgetConfig["onExceed"] {
    return this.onExceed;
  }

  getLimits(): BudgetLimits {
    return { ...this.limits };
  }

  hasLimits(): boolean {
    return LIMIT_KEYS.some((k) => this.limits[k] !== undefined);
  }

  /** Replace session totals and clear session-scoped warn/exceed memory (new or resumed session). */
  loadSession(totals: UsageTotals): Crossing[] {
    for (const key of LIMIT_KEYS) {
      if (LIMIT_SCOPE[key] === "session") this.forget(key);
    }
    this.totals = { ...totals };
    return this.evaluate();
  }

  /** Replace session totals, keeping warn/exceed memory. Use after re-reading the session entries. */
  syncSession(totals: UsageTotals): Crossing[] {
    this.totals = { ...totals };
    return this.evaluate();
  }

  addUsage(usage: UsageLike): Crossing[] {
    addUsage(this.totals, usage);
    return this.evaluate();
  }

  /** Begin an agent run: reset turns, tool calls and the wall-clock timer. */
  startRun(now: number = this.clock()): Crossing[] {
    for (const key of LIMIT_KEYS) {
      if (LIMIT_SCOPE[key] === "run") this.forget(key);
    }
    this.turns = 0;
    this.toolCalls = 0;
    this.frozenElapsedMs = 0;
    this.runStartedAt = now;
    return this.evaluate(now);
  }

  /** End the current run, freezing the elapsed time. */
  endRun(now: number = this.clock()): void {
    if (this.runStartedAt !== undefined) {
      this.frozenElapsedMs = Math.max(0, now - this.runStartedAt);
      this.runStartedAt = undefined;
    }
  }

  get running(): boolean {
    return this.runStartedAt !== undefined;
  }

  recordTurn(): Crossing[] {
    this.turns += 1;
    return this.evaluate();
  }

  recordToolCall(): Crossing[] {
    this.toolCalls += 1;
    return this.evaluate();
  }

  /** Re-evaluate time-based limits. */
  checkTime(now: number = this.clock()): Crossing[] {
    return this.evaluate(now);
  }

  /** Set or clear (`undefined`) one limit. Warn/exceed memory for that limit is reset. */
  setLimit(key: LimitKey, value: number | undefined): Crossing[] {
    if (value === undefined) delete this.limits[key];
    else this.limits[key] = value;
    this.forget(key);
    return this.evaluate();
  }

  used(key: LimitKey, now: number = this.clock()): number {
    const t = this.totals;
    switch (key) {
      case "usd":
        return t.cost;
      case "tokens":
        return t.input + t.output + t.cacheRead + t.cacheWrite;
      case "inputTokens":
        return t.input + t.cacheRead + t.cacheWrite;
      case "outputTokens":
        return t.output;
      case "turns":
        return this.turns;
      case "toolCalls":
        return this.toolCalls;
      case "minutes":
        return this.elapsedMs(now) / MS_PER_MINUTE;
    }
  }

  sessionTotals(): UsageTotals {
    return { ...this.totals };
  }

  /** Current state of every configured limit (computed, not "once"-filtered). */
  state(now: number = this.clock()): LimitState[] {
    const out: LimitState[] = [];
    for (const key of LIMIT_KEYS) {
      const max = this.limits[key];
      if (max === undefined) continue;
      const used = this.used(key, now);
      out.push({ limit: key, scope: LIMIT_SCOPE[key], used, max, status: this.statusOf(used, max) });
    }
    return out;
  }

  exceededLimits(now: number = this.clock()): LimitState[] {
    return this.state(now).filter((s) => s.status === "exceeded");
  }

  isExceeded(now: number = this.clock()): boolean {
    return this.exceededLimits(now).length > 0;
  }

  /**
   * True when a USD limit is set and tokens were spent but the cost is still 0, which is what
   * unpriced (e.g. local) models report.
   */
  looksUnpriced(): boolean {
    return this.limits.usd !== undefined && this.used("tokens") > 0 && this.totals.cost === 0;
  }

  /** Milliseconds until the next wall-time threshold (warn or exceed), or undefined if none is pending. */
  msUntilNextTimeThreshold(now: number = this.clock()): number | undefined {
    const max = this.limits.minutes;
    if (max === undefined || this.runStartedAt === undefined) return undefined;
    const candidates: number[] = [];
    if (!this.exceededSeen.has("minutes")) {
      if (!this.warned.has("minutes") && this.warnAt < 1) candidates.push(max * this.warnAt * MS_PER_MINUTE);
      candidates.push(max * MS_PER_MINUTE);
    }
    if (candidates.length === 0) return undefined;
    const elapsed = this.elapsedMs(now);
    return Math.max(0, Math.ceil(Math.min(...candidates) - elapsed));
  }

  /** Compact status line, e.g. "$0.12/$1.00 · 12.3k/200k tok · 4/20 turns · 2m/30m". Empty without limits. */
  format(now: number = this.clock()): string {
    return this.state(now)
      .map((s) => formatLimit(s.limit, s.used, s.max) + (s.status === "exceeded" ? "!" : ""))
      .join(" · ");
  }

  private elapsedMs(now: number): number {
    return this.runStartedAt === undefined ? this.frozenElapsedMs : Math.max(0, now - this.runStartedAt);
  }

  private statusOf(used: number, max: number): LimitStatus {
    if (used >= max) return "exceeded";
    if (used >= max * this.warnAt) return "warn";
    return "ok";
  }

  private forget(key: LimitKey): void {
    this.warned.delete(key);
    this.exceededSeen.delete(key);
  }

  private evaluate(now: number = this.clock()): Crossing[] {
    const crossings: Crossing[] = [];
    for (const key of LIMIT_KEYS) {
      const max = this.limits[key];
      if (max === undefined) continue;
      const used = this.used(key, now);
      const status = this.statusOf(used, max);
      if (status === "exceeded" && !this.exceededSeen.has(key)) {
        this.exceededSeen.add(key);
        this.warned.add(key);
        crossings.push({ type: "exceed", limit: key, used, max });
      } else if (status === "warn" && !this.warned.has(key)) {
        this.warned.add(key);
        crossings.push({ type: "warn", limit: key, used, max });
      }
    }
    return crossings;
  }
}
