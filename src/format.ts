import type { LimitKey } from "./types.js";

/** 950 -> "950", 12300 -> "12.3k", 200000 -> "200k", 1500000 -> "1.5M". */
export function formatCount(n: number): string {
  const trim = (x: number, digits: number) => x.toFixed(digits).replace(/\.0+$/, "");
  if (n >= 1_000_000) return `${trim(n / 1_000_000, 1)}M`;
  if (n >= 1_000) return `${trim(n / 1_000, 1)}k`;
  return trim(n, 0);
}

export function formatUsd(n: number): string {
  return n === 0 || n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

export function formatMinutes(n: number): string {
  const text = n < 10 ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n));
  return `${text}m`;
}

interface Piece {
  used: (n: number) => string;
  max: (n: number) => string;
  suffix: string;
}

const count = (n: number) => formatCount(n);
const whole = (n: number) => String(Math.round(n));

const PIECES: Record<LimitKey, Piece> = {
  usd: { used: formatUsd, max: formatUsd, suffix: "" },
  tokens: { used: count, max: count, suffix: " tok" },
  inputTokens: { used: count, max: count, suffix: " in" },
  outputTokens: { used: count, max: count, suffix: " out" },
  turns: { used: whole, max: whole, suffix: " turns" },
  toolCalls: { used: whole, max: whole, suffix: " tools" },
  minutes: { used: formatMinutes, max: formatMinutes, suffix: "" },
};

/** `used/max` text for one limit, e.g. "12.3k/200k tok". */
export function formatLimit(key: LimitKey, used: number, max: number): string {
  const piece = PIECES[key];
  return `${piece.used(used)}/${piece.max(max)}${piece.suffix}`;
}

/** Text for a limit value alone, e.g. "$2.00", "200k tok", "30m". */
export function formatMax(key: LimitKey, max: number): string {
  const piece = PIECES[key];
  return `${piece.max(max)}${piece.suffix}`;
}
