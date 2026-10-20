import type { LimitKey, LimitScope } from "./types.js";

export const LIMIT_KEYS = [
  "usd",
  "tokens",
  "inputTokens",
  "outputTokens",
  "turns",
  "toolCalls",
  "minutes",
] as const satisfies readonly LimitKey[];

export const LIMIT_SCOPE: Record<LimitKey, LimitScope> = {
  usd: "session",
  tokens: "session",
  inputTokens: "session",
  outputTokens: "session",
  turns: "run",
  toolCalls: "run",
  minutes: "run",
};

/** Limits that must be whole numbers. */
const INTEGER_KEYS: ReadonlySet<LimitKey> = new Set(["tokens", "inputTokens", "outputTokens", "turns", "toolCalls"]);

const KEBAB: Record<string, LimitKey> = {
  usd: "usd",
  tokens: "tokens",
  "input-tokens": "inputTokens",
  "output-tokens": "outputTokens",
  turns: "turns",
  "tool-calls": "toolCalls",
  minutes: "minutes",
};

/** Resolve `tool-calls` / `toolCalls` / `TOOL_CALLS` style names to a limit key. */
export function resolveLimitKey(name: string): LimitKey | undefined {
  const trimmed = name.trim();
  if ((LIMIT_KEYS as readonly string[]).includes(trimmed)) return trimmed as LimitKey;
  const kebab = trimmed.toLowerCase().replace(/_/g, "-");
  return Object.hasOwn(KEBAB, kebab) ? KEBAB[kebab] : undefined;
}

/** Kebab-case spelling of a limit key, as used by CLI flags and the /budget command. */
export function kebabName(key: LimitKey): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Plain decimal notation only: no sign, hex, octal, binary or `Infinity`. */
const DECIMAL = /^\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * Parse and validate a limit value. Strings (env vars, CLI flags) must be plain decimals.
 * Throws a plain `Error` with a human-readable message; callers add the source.
 */
export function parseLimitValue(key: LimitKey, raw: unknown): number {
  let value: number;
  if (typeof raw === "number") value = raw;
  else if (typeof raw === "string" && DECIMAL.test(raw.trim())) value = Number(raw.trim());
  else throw new Error(`"${key}" must be a positive number, got ${JSON.stringify(raw)}`);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`"${key}" must be a positive number, got ${JSON.stringify(raw)}`);
  }
  if (INTEGER_KEYS.has(key) && !Number.isInteger(value)) {
    throw new Error(`"${key}" must be a whole number, got ${JSON.stringify(raw)}`);
  }
  return value;
}
