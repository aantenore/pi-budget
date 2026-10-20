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

/**
 * Outcome of parsing one config source leniently: `layer` holds only the valid keys, `problems`
 * names every dropped key, and `fatal` is set when the whole source is unusable (unreadable,
 * invalid JSON, not an object), in which case its contents are unknown.
 */
export interface LayerResult {
  layer: ConfigLayer;
  problems: string[];
  fatal?: string;
}

/** Parse the contents of a budget JSON file (or an equivalent object), dropping invalid keys instead of throwing. */
export function parseLayer(input: unknown, source: string): LayerResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { layer: {}, problems: [], fatal: `${source}: expected a JSON object` };
  }
  const obj = input as Record<string, unknown>;
  const problems: string[] = [];
  const layer: ConfigLayer = {};

  for (const key of Object.keys(obj)) {
    if (!FILE_KEYS.includes(key)) problems.push(`unknown key "${key}" (allowed: ${FILE_KEYS.join(", ")})`);
  }

  if (obj.limits !== undefined) {
    const raw = obj.limits;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      problems.push(`"limits" must be an object`);
    } else {
      const limits: BudgetLimits = {};
      for (const [key, value] of Object.entries(raw)) {
        if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
          problems.push(`unknown limit "${key}" (allowed: ${LIMIT_KEYS.join(", ")})`);
          continue;
        }
        if (value === undefined || value === null) continue;
        try {
          limits[key as LimitKey] = parseLimitValue(key as LimitKey, value);
        } catch (e) {
          problems.push((e as Error).message);
        }
      }
      layer.limits = limits;
    }
  }
  if (obj.warnAt !== undefined) {
    try {
      layer.warnAt = parseWarnAt(obj.warnAt);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  if (obj.onExceed !== undefined) {
    try {
      layer.onExceed = parseOnExceed(obj.onExceed);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  return { layer, problems };
}

/** Message for a source that had problems, as thrown by the strict validators. */
function describeProblems(result: LayerResult, label: string): string | undefined {
  if (result.fatal) return result.fatal;
  return result.problems.length > 0 ? `${label}: ${result.problems.join("; ")}` : undefined;
}

/** Validate the contents of a budget JSON file (or an equivalent object). Throws one error listing every problem. */
export function validateLayer(input: unknown, source: string): ConfigLayer {
  const result = parseLayer(input, source);
  const message = describeProblems(result, `invalid config in ${source}`);
  if (message) throw new BudgetConfigError(message);
  return result.layer;
}

/** Read and parse a JSON config file leniently. Returns undefined when the file does not exist. */
export function parseLayerFile(path: string): LayerResult | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { layer: {}, problems: [], fatal: `cannot read ${path}: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { layer: {}, problems: [], fatal: `invalid JSON in ${path}: ${(e as Error).message}` };
  }
  return parseLayer(parsed, path);
}

/** Read and validate a JSON config file. Returns undefined when the file does not exist. */
export function readLayerFile(path: string): ConfigLayer | undefined {
  const result = parseLayerFile(path);
  if (!result) return undefined;
  const message = describeProblems(result, `invalid config in ${path}`);
  if (message) throw new BudgetConfigError(message);
  return result.layer;
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

/** Parse environment variables, dropping invalid ones instead of throwing. */
export function parseEnvLayer(env: Record<string, string | undefined>): LayerResult {
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
  if (Object.keys(limits).length > 0) layer.limits = limits;
  return { layer, problems: errors };
}

export function layerFromEnv(env: Record<string, string | undefined>): ConfigLayer {
  const result = parseEnvLayer(env);
  const message = describeProblems(result, "invalid environment");
  if (message) throw new BudgetConfigError(message);
  return result.layer;
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

/** Parse CLI flag values, dropping invalid ones instead of throwing. */
export function parseFlagsLayer(flags: FlagValues): LayerResult {
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
  if (Object.keys(limits).length > 0) layer.limits = limits;
  return { layer, problems: errors };
}

export function layerFromFlags(flags: FlagValues): ConfigLayer {
  const result = parseFlagsLayer(flags);
  const message = describeProblems(result, "invalid flags");
  if (message) throw new BudgetConfigError(message);
  return result.layer;
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
 * Apply the project layer on top of the trusted configuration. The project file lives in the
 * repository being worked on and may come from someone else, so it can only tighten: it never
 * raises a limit, never turns `stop` into `warn`, and never delays warnings.
 */
export function tightenWithProject(base: BudgetConfig, project: ConfigLayer | undefined): BudgetConfig {
  if (!project) return base;
  const config: BudgetConfig = { ...base, limits: { ...base.limits } };
  for (const [key, value] of Object.entries(project.limits ?? {}) as [LimitKey, number][]) {
    const current = config.limits[key];
    config.limits[key] = current === undefined ? value : Math.min(current, value);
  }
  if (project.warnAt !== undefined && project.warnAt < config.warnAt) config.warnAt = project.warnAt;
  if (project.onExceed === "stop") config.onExceed = "stop";
  return config;
}

/** Effective configuration plus everything that had to be ignored to build it. */
export interface ConfigReport {
  config: BudgetConfig;
  /** One message per source that had invalid keys; the valid keys of that source still apply. */
  problems: string[];
  /** True when a whole source could not be loaded (unreadable file, invalid JSON, not an object). */
  unusable: boolean;
}

/**
 * Load the effective configuration without throwing: every valid key of every source is kept and
 * invalid keys are dropped and reported. Precedence, lowest to highest: defaults,
 * `~/.pi/budget.json`, environment variables, CLI flags; then `<project>/.pi/budget.json` may only
 * tighten the result (see {@link tightenWithProject}).
 */
export function loadConfigReport(options: LoadConfigOptions = {}): ConfigReport {
  const home = options.homeDir ?? homedir();
  const problems: string[] = [];
  let unusable = false;
  const take = (result: LayerResult | undefined, label: string): ConfigLayer | undefined => {
    if (!result) return undefined;
    const message = describeProblems(result, label);
    if (message) problems.push(message);
    if (result.fatal) unusable = true;
    return result.layer;
  };

  const userPath = join(home, ".pi", "budget.json");
  const user = take(parseLayerFile(userPath), `invalid config in ${userPath}`);
  const projectPath = options.cwd ? join(options.cwd, ".pi", "budget.json") : undefined;
  const project = projectPath ? take(parseLayerFile(projectPath), `invalid config in ${projectPath}`) : undefined;
  const env = take(parseEnvLayer(options.env ?? process.env), "invalid environment");
  const flags = take(parseFlagsLayer(options.flags ?? {}), "invalid flags");

  return { config: tightenWithProject(mergeLayers(user, env, flags), project), problems, unusable };
}

/**
 * Load the effective configuration and throw when any source has a problem. See
 * {@link loadConfigReport} for the precedence and for a variant that never throws.
 */
export function loadConfig(options: LoadConfigOptions = {}): BudgetConfig {
  const report = loadConfigReport(options);
  if (report.problems.length > 0) throw new BudgetConfigError(report.problems.join("; "));
  return report.config;
}
