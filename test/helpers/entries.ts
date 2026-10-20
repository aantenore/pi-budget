import type { SessionEntryLike } from "../../src/entries.js";

export function usage(overrides: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number } = {}) {
  const input = overrides.input ?? 0;
  const output = overrides.output ?? 0;
  const cacheRead = overrides.cacheRead ?? 0;
  const cacheWrite = overrides.cacheWrite ?? 0;
  const cost = overrides.cost ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

export const assistantEntry = (u: ReturnType<typeof usage>): SessionEntryLike => ({
  type: "message",
  message: { role: "assistant", content: [], usage: u },
});

export const toolResultEntry = (u?: ReturnType<typeof usage>): SessionEntryLike => ({
  type: "message",
  message: { role: "toolResult", content: [], ...(u ? { usage: u } : {}) },
});

export const userEntry = (): SessionEntryLike => ({ type: "message", message: { role: "user", content: "hi" } });

export const usageEntry = (u: ReturnType<typeof usage>): SessionEntryLike => ({
  type: "usage",
  usage: u,
  kind: "cache_warm",
} as SessionEntryLike);

export const compactionEntry = (u?: ReturnType<typeof usage>): SessionEntryLike => ({
  type: "compaction",
  ...(u ? { usage: u } : {}),
});

export const branchSummaryEntry = (u?: ReturnType<typeof usage>): SessionEntryLike => ({
  type: "branch_summary",
  ...(u ? { usage: u } : {}),
});
