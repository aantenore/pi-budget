import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LIMIT_KEYS, parseLimitValue } from "./limits.js";
import type { BudgetConfig, BudgetLimits, LimitKey, OnExceed } from "./types.js";

export const DEFAULT_WARN_AT = 0.8;

export const DEFAULT_CONFIG: BudgetConfig = {
  limits: {},
  warnAt: DEFAULT_WARN_AT,
  onExceed: "stop",
};

/** Partial configuration from one source. Merged key by key, later layers win. */
export interface ConfigLayer {
  limits?: BudgetLimits;
  warnAt?: number;
  onExceed?: OnExceed;
}

export class BudgetConfigError extends Error {
  constructor(message: string) {
    super(`pi-budget: ${message}`);
    this.name = "BudgetConfigError";
  }
}

export function parseWarnAt(raw: unknown): number {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`"warnAt" must be a number greater than 0 and at most 1, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseOnExceed(raw: unknown): OnExceed {
  if (raw === "stop" || raw === "warn") return raw;
  throw new Error(`"onExceed" must be "stop" or "warn", got ${JSON.stringify(raw)}`);
}

const FILE_KEYS = ["limits", "warnAt", "onExceed"];

/** Validate the contents of a budget JSON file (or an equivalent object). Throws one error listing every problem. */
export function validateLayer(input: unknown, source: string): ConfigLayer {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new BudgetConfigError(`${source}: expected a JSON object`);
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];
  const layer: ConfigLayer = {};

  for (const key of Object.keys(obj)) {
    if (!FILE_KEYS.includes(key)) errors.push(`unknown key "${key}" (allowed: ${FILE_KEYS.join(", ")})`);
  }

  if (obj.limits !== undefined) {
    const raw = obj.limits;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`"limits" must be an object`);
    } else {
      const limits: BudgetLimits = {};
      for (const [key, value] of Object.entries(raw)) {
        if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
          errors.push(`unknown limit "${key}" (allowed: ${LIMIT_KEYS.join(", ")})`);
          continue;
        }
        if (value === undefined || value === null) continue;
        try {
          limits[key as LimitKey] = parseLimitValue(key as LimitKey, value);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      layer.limits = limits;
    }
  }
  if (obj.warnAt !== undefined) {
    try {
      layer.warnAt = parseWarnAt(obj.warnAt);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (obj.onExceed !== undefined) {
    try {
      layer.onExceed = parseOnExceed(obj.onExceed);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  if (errors.length > 0) throw new BudgetConfigError(`invalid config in ${source}: ${errors.join("; ")}`);
  return layer;
}

/** Read and validate a JSON config file. Returns undefined when the file does not exist. */
export function readLayerFile(path: string): ConfigLayer | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new BudgetConfigError(`cannot read ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new BudgetConfigError(`invalid JSON in ${path}: ${(e as Error).message}`);
  }
  return validateLayer(parsed, path);
}

/** Environment variable name for each limit that has one. */
export const ENV_LIMITS: Partial<Record<LimitKey, string>> = {
  usd: "PI_BUDGET_USD",
  tokens: "PI_BUDGET_TOKENS",
  turns: "PI_BUDGET_TURNS",
  toolCalls: "PI_BUDGET_TOOL_CALLS",
  minutes: "PI_BUDGET_MINUTES",
};
export const ENV_ON_EXCEED = "PI_BUDGET_ON_EXCEED";
export const ENV_WARN_AT = "PI_BUDGET_WARN_AT";

const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

export function layerFromEnv(env: Record<string, string | undefined>): ConfigLayer {
  const errors: string[] = [];
  const layer: ConfigLayer = {};
  const limits: BudgetLimits = {};

  for (const [key, name] of Object.entries(ENV_LIMITS) as [LimitKey, string][]) {
    const raw = env[name];
    if (!present(raw)) continue;
    try {
      limits[key] = parseLimitValue(key, raw);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  if (present(env[ENV_WARN_AT])) {
    try {
      layer.warnAt = parseWarnAt(env[ENV_WARN_AT]);
    } catch (e) {
      errors.push(`${ENV_WARN_AT}: ${(e as Error).message}`);
    }
  }
  if (present(env[ENV_ON_EXCEED])) {
    try {
      layer.onExceed = parseOnExceed(env[ENV_ON_EXCEED]!.trim());
    } catch (e) {
      errors.push(`${ENV_ON_EXCEED}: ${(e as Error).message}`);
    }
  }
  if (errors.length > 0) throw new BudgetConfigError(`invalid environment: ${errors.join("; ")}`);
  if (Object.keys(limits).length > 0) layer.limits = limits;
  return layer;
}

/** CLI flag values, keyed by limit name (without the `budget-` prefix). */
export type FlagValues = Partial<Record<"usd" | "tokens" | "turns" | "toolCalls" | "minutes" | "onExceed", string | boolean | undefined>>;

export const FLAG_NAMES = {
  usd: "budget-usd",
  tokens: "budget-tokens",
  turns: "budget-turns",
  toolCalls: "budget-tool-calls",
  minutes: "budget-minutes",
  onExceed: "budget-on-exceed",
} as const satisfies Record<keyof FlagValues, string>;

export function layerFromFlags(flags: FlagValues): ConfigLayer {
  const errors: string[] = [];
  const layer: ConfigLayer = {};
  const limits: BudgetLimits = {};

  const text = (name: keyof FlagValues): string | undefined => {
    const raw = flags[name];
    if (raw === undefined || raw === false) return undefined;
    if (raw === true) {
      errors.push(`--${FLAG_NAMES[name]} needs a value`);
      return undefined;
    }
    return present(raw) ? raw.trim() : undefined;
  };

  for (const key of ["usd", "tokens", "turns", "toolCalls", "minutes"] as const) {
    const raw = text(key);
    if (raw === undefined) continue;
    try {
      limits[key] = parseLimitValue(key, raw);
    } catch (e) {
      errors.push(`--${FLAG_NAMES[key]}: ${(e as Error).message}`);
    }
  }
  const onExceed = text("onExceed");
  if (onExceed !== undefined) {
    try {
      layer.onExceed = parseOnExceed(onExceed);
    } catch (e) {
      errors.push(`--${FLAG_NAMES.onExceed}: ${(e as Error).message}`);
    }
  }
  if (errors.length > 0) throw new BudgetConfigError(`invalid flags: ${errors.join("; ")}`);
  if (Object.keys(limits).length > 0) layer.limits = limits;
  return layer;
}

/** Merge layers, lowest precedence first, on top of the defaults. */
export function mergeLayers(...layers: (ConfigLayer | undefined)[]): BudgetConfig {
  const config: BudgetConfig = { limits: {}, warnAt: DEFAULT_CONFIG.warnAt, onExceed: DEFAULT_CONFIG.onExceed };
  for (const layer of layers) {
    if (!layer) continue;
    Object.assign(config.limits, layer.limits);
    if (layer.warnAt !== undefined) config.warnAt = layer.warnAt;
    if (layer.onExceed !== undefined) config.onExceed = layer.onExceed;
  }
  return config;
}

/** Validate a programmatic config (SDK use) and fill in defaults. */
export function normalizeConfig(input: Partial<BudgetConfig>): BudgetConfig {
  return mergeLayers(validateLayer(input, "budget config"));
}

export interface LoadConfigOptions {
  /** Project directory; `<cwd>/.pi/budget.json` is read. Omit to skip the project file. */
  cwd?: string;
  /** Home directory; `<home>/.pi/budget.json` is read. Defaults to the OS home directory. */
  homeDir?: string;
  env?: Record<string, string | undefined>;
  flags?: FlagValues;
}

/**
 * Load the effective configuration. Precedence, lowest to highest:
 * defaults, `~/.pi/budget.json`, `<project>/.pi/budget.json`, environment variables, CLI flags.
 */
export function loadConfig(options: LoadConfigOptions = {}): BudgetConfig {
  const home = options.homeDir ?? homedir();
  const userFile = readLayerFile(join(home, ".pi", "budget.json"));
  const projectFile = options.cwd ? readLayerFile(join(options.cwd, ".pi", "budget.json")) : undefined;
  const env = layerFromEnv(options.env ?? process.env);
  const flags = layerFromFlags(options.flags ?? {});
  return mergeLayers(userFile, projectFile, env, flags);
}
