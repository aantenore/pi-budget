import { addUsage, emptyTotals } from "./tracker.js";
import type { UsageLike, UsageTotals } from "./types.js";

/**
 * Structural view of a Pi session entry. Pi's own `SessionEntry` union is assignable to it,
 * so this module needs no runtime dependency on the host.
 */
export interface SessionEntryLike {
  type: string;
  message?: unknown;
  usage?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const asUsage = (value: unknown): UsageLike | undefined => (isObject(value) ? (value as UsageLike) : undefined);

/**
 * Rebuild session usage totals from session entries, mirroring how Pi computes its own
 * session stats: assistant message usage, tool-result usage, `usage` entries (for example
 * cache warming), and usage recorded on compaction and branch-summary entries.
 */
export function totalsFromEntries(entries: readonly SessionEntryLike[]): UsageTotals {
  const totals = emptyTotals();
  for (const entry of entries) {
    if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      const usage = asUsage(entry.usage);
      if (usage) addUsage(totals, usage);
    } else if (entry.type === "message" && isObject(entry.message)) {
      const role = entry.message.role;
      if (role === "assistant" || role === "toolResult") {
        const usage = asUsage(entry.message.usage);
        if (usage) addUsage(totals, usage);
      }
    }
  }
  return totals;
}
