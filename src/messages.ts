import { formatLimit } from "./format.js";
import { kebabName } from "./limits.js";
import type { Crossing } from "./types.js";

type Measured = Pick<Crossing, "limit" | "used" | "max">;

/** "approaching tokens limit (160k/200k tok)" / "reached usd limit ($1.02/$1.00)". */
export function describeCrossing(c: Crossing): string {
  const verb = c.type === "warn" ? "approaching" : "reached";
  return `${verb} ${kebabName(c.limit)} limit (${formatLimit(c.limit, c.used, c.max)})`;
}

/** Reason attached to tool calls blocked after a limit was exceeded. */
export function exceededReason(exceeded: readonly Measured[]): string {
  const detail = exceeded.map((s) => `${kebabName(s.limit)} ${formatLimit(s.limit, s.used, s.max)}`).join(", ");
  return `Budget exceeded (${detail}). The run was stopped by pi-budget; do not retry tool calls.`;
}
