import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BudgetConfigError,
  DEFAULT_CONFIG,
  layerFromEnv,
  layerFromFlags,
  loadConfig,
  normalizeConfig,
  validateLayer,
} from "../src/config.js";
import { parseLimitValue, resolveLimitKey } from "../src/limits.js";

let root: string;
let home: string;
let project: string;

const writeJson = (dir: string, value: unknown) => {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "budget.json"), typeof value === "string" ? value : JSON.stringify(value));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-budget-config-"));
  home = join(root, "home");
  project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadConfig precedence", () => {
  it("returns defaults when nothing is configured", () => {
    expect(loadConfig({ homeDir: home, cwd: project, env: {} })).toEqual(DEFAULT_CONFIG);
  });

  it("merges defaults < user file < project file < env < flags, key by key", () => {
    writeJson(home, { limits: { usd: 1, tokens: 1000, turns: 10 }, warnAt: 0.5, onExceed: "warn" });
    writeJson(project, { limits: { usd: 2, toolCalls: 20 }, onExceed: "stop" });
    const env = { PI_BUDGET_USD: "3", PI_BUDGET_MINUTES: "15", PI_BUDGET_WARN_AT: "0.9" };
    const flags = { usd: "4", onExceed: "warn" } as const;

    const config = loadConfig({ homeDir: home, cwd: project, env, flags });
    expect(config).toEqual({
      limits: { usd: 4, tokens: 1000, turns: 10, toolCalls: 20, minutes: 15 },
      warnAt: 0.9,
      onExceed: "warn",
    });
  });

  it("applies each layer in order", () => {
    writeJson(home, { limits: { usd: 1 } });
    expect(loadConfig({ homeDir: home, cwd: project, env: {} }).limits.usd).toBe(1);
    writeJson(project, { limits: { usd: 2 } });
    expect(loadConfig({ homeDir: home, cwd: project, env: {} }).limits.usd).toBe(2);
    expect(loadConfig({ homeDir: home, cwd: project, env: { PI_BUDGET_USD: "3" } }).limits.usd).toBe(3);
    expect(loadConfig({ homeDir: home, cwd: project, env: { PI_BUDGET_USD: "3" }, flags: { usd: "4" } }).limits.usd).toBe(4);
  });

  it("reads every documented env var", () => {
    const config = loadConfig({
      homeDir: home,
      env: {
        PI_BUDGET_USD: "2.5",
        PI_BUDGET_TOKENS: "200000",
        PI_BUDGET_TURNS: "30",
        PI_BUDGET_TOOL_CALLS: "100",
        PI_BUDGET_MINUTES: "45",
        PI_BUDGET_ON_EXCEED: "warn",
        PI_BUDGET_WARN_AT: "0.7",
      },
    });
    expect(config).toEqual({
      limits: { usd: 2.5, tokens: 200000, turns: 30, toolCalls: 100, minutes: 45 },
      warnAt: 0.7,
      onExceed: "warn",
    });
  });

  it("ignores empty env vars and unset flags", () => {
    const config = loadConfig({
      homeDir: home,
      env: { PI_BUDGET_USD: "", PI_BUDGET_ON_EXCEED: "  " },
      flags: { usd: undefined, turns: false },
    });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("skips the project file when no cwd is given", () => {
    writeJson(project, { limits: { usd: 2 } });
    expect(loadConfig({ homeDir: home, env: {} }).limits).toEqual({});
  });
});

describe("config validation", () => {
  it("rejects non-positive and non-numeric limits with the offending name", () => {
    expect(() => validateLayer({ limits: { usd: 0 } }, "x")).toThrow(/"usd" must be a positive number/);
    expect(() => validateLayer({ limits: { usd: -1 } }, "x")).toThrow(BudgetConfigError);
    expect(() => validateLayer({ limits: { turns: "ten" } }, "x")).toThrow(/"turns"/);
    expect(() => validateLayer({ limits: { turns: 2.5 } }, "x")).toThrow(/whole number/);
    expect(() => validateLayer({ limits: { minutes: 0.5 } }, "x")).not.toThrow();
  });

  it("rejects unknown keys and bad shapes", () => {
    expect(() => validateLayer({ limit: {} }, "f.json")).toThrow(/f\.json.*unknown key "limit"/);
    expect(() => validateLayer({ limits: { dollars: 1 } }, "f.json")).toThrow(/unknown limit "dollars"/);
    expect(() => validateLayer({ limits: [] }, "f.json")).toThrow(/"limits" must be an object/);
    expect(() => validateLayer([], "f.json")).toThrow(/expected a JSON object/);
    expect(() => validateLayer(null, "f.json")).toThrow(/expected a JSON object/);
  });

  it("validates warnAt and onExceed", () => {
    expect(() => validateLayer({ warnAt: 0 }, "x")).toThrow(/warnAt/);
    expect(() => validateLayer({ warnAt: 1.2 }, "x")).toThrow(/warnAt/);
    expect(() => validateLayer({ warnAt: 1 }, "x")).not.toThrow();
    expect(() => validateLayer({ onExceed: "kill" }, "x")).toThrow(/"onExceed" must be "stop" or "warn"/);
  });

  it("reports every problem in one error", () => {
    try {
      validateLayer({ limits: { usd: -1, turns: "x" }, onExceed: "no" }, "x");
      expect.unreachable();
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('"usd"');
      expect(message).toContain('"turns"');
      expect(message).toContain('"onExceed"');
    }
  });

  it("names the file for invalid JSON and bad content", () => {
    writeJson(home, "{not json");
    expect(() => loadConfig({ homeDir: home, env: {} })).toThrow(/invalid JSON in .*budget\.json/);
    writeJson(home, { limits: { usd: -3 } });
    expect(() => loadConfig({ homeDir: home, env: {} })).toThrow(/invalid config in .*budget\.json/);
  });

  it("names the env var or flag that is invalid", () => {
    expect(() => layerFromEnv({ PI_BUDGET_USD: "abc" })).toThrow(/PI_BUDGET_USD/);
    expect(() => layerFromEnv({ PI_BUDGET_TURNS: "1.5" })).toThrow(/PI_BUDGET_TURNS/);
    expect(() => layerFromEnv({ PI_BUDGET_ON_EXCEED: "maybe" })).toThrow(/PI_BUDGET_ON_EXCEED/);
    expect(() => layerFromEnv({ PI_BUDGET_WARN_AT: "2" })).toThrow(/PI_BUDGET_WARN_AT/);
    expect(() => layerFromFlags({ usd: "-1" })).toThrow(/--budget-usd/);
    expect(() => layerFromFlags({ toolCalls: true })).toThrow(/--budget-tool-calls needs a value/);
    expect(() => layerFromFlags({ onExceed: "nope" })).toThrow(/--budget-on-exceed/);
  });

  it("normalizes programmatic config with defaults", () => {
    expect(normalizeConfig({ limits: { usd: 1 } })).toEqual({ limits: { usd: 1 }, warnAt: 0.8, onExceed: "stop" });
    expect(() => normalizeConfig({ limits: { usd: -1 } })).toThrow(BudgetConfigError);
  });
});

describe("limit helpers", () => {
  it("resolves limit names in several spellings", () => {
    expect(resolveLimitKey("tool-calls")).toBe("toolCalls");
    expect(resolveLimitKey("toolCalls")).toBe("toolCalls");
    expect(resolveLimitKey("TOOL_CALLS")).toBe("toolCalls");
    expect(resolveLimitKey("input-tokens")).toBe("inputTokens");
    expect(resolveLimitKey("nope")).toBeUndefined();
  });

  it("parses numeric strings", () => {
    expect(parseLimitValue("usd", " 2.5 ")).toBe(2.5);
    expect(() => parseLimitValue("usd", "")).toThrow();
    expect(() => parseLimitValue("usd", "Infinity")).toThrow();
  });
});
