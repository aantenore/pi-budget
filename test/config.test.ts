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
  loadConfigReport,
  normalizeConfig,
  parseWarnAt,
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

  it("merges defaults < user file < env < flags, key by key", () => {
    writeJson(home, { limits: { usd: 1, tokens: 1000, turns: 10 }, warnAt: 0.5, onExceed: "warn" });
    const env = { PI_BUDGET_USD: "3", PI_BUDGET_MINUTES: "15", PI_BUDGET_WARN_AT: "0.9" };
    const flags = { usd: "4", onExceed: "stop" } as const;

    const config = loadConfig({ homeDir: home, env, flags });
    expect(config).toEqual({
      limits: { usd: 4, tokens: 1000, turns: 10, minutes: 15 },
      warnAt: 0.9,
      onExceed: "stop",
    });
  });

  it("applies user file, env and flags in order", () => {
    writeJson(home, { limits: { usd: 1 } });
    expect(loadConfig({ homeDir: home, env: {} }).limits.usd).toBe(1);
    expect(loadConfig({ homeDir: home, env: { PI_BUDGET_USD: "3" } }).limits.usd).toBe(3);
    expect(loadConfig({ homeDir: home, env: { PI_BUDGET_USD: "3" }, flags: { usd: "4" } }).limits.usd).toBe(4);
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

describe("untrusted project config only tightens", () => {
  const load = (extra: Partial<Parameters<typeof loadConfig>[0]> = {}) =>
    loadConfig({ homeDir: home, cwd: project, env: {}, ...extra });

  it("takes the lower limit and may add a limit the user did not set", () => {
    writeJson(home, { limits: { usd: 5, turns: 10 } });
    writeJson(project, { limits: { usd: 2, turns: 50, toolCalls: 20 } });
    expect(load().limits).toEqual({ usd: 2, turns: 10, toolCalls: 20 });
  });

  it("cannot raise a limit set by env or flags", () => {
    writeJson(project, { limits: { usd: 100, tokens: 500 } });
    const config = load({ env: { PI_BUDGET_USD: "3" }, flags: { tokens: "1000" } });
    expect(config.limits).toEqual({ usd: 3, tokens: 500 });
  });

  it("can switch warn to stop but never stop to warn", () => {
    writeJson(home, { onExceed: "warn" });
    writeJson(project, { onExceed: "stop" });
    expect(load().onExceed).toBe("stop");
    writeJson(home, { onExceed: "stop" });
    writeJson(project, { onExceed: "warn" });
    expect(load().onExceed).toBe("stop");
    expect(load({ flags: { onExceed: "stop" } }).onExceed).toBe("stop");
    rmSync(join(home, ".pi"), { recursive: true });
    expect(load().onExceed).toBe("stop"); // the default stop is not relaxed by a warn project either
    expect(load({ flags: { onExceed: "warn" } }).onExceed).toBe("warn"); // the user's own choice still wins
  });

  it("applies warnAt from the project only when lower", () => {
    writeJson(home, { warnAt: 0.7 });
    writeJson(project, { warnAt: 0.9 });
    expect(load().warnAt).toBe(0.7);
    writeJson(project, { warnAt: 0.5 });
    expect(load().warnAt).toBe(0.5);
  });
});

describe("loadConfigReport keeps valid layers", () => {
  it("drops only the invalid keys and reports them", () => {
    writeJson(home, { limits: { usd: 2, turns: -1 }, onExceed: "warn", bogus: 1 });
    writeJson(project, { limits: { toolCalls: 7 } });
    const report = loadConfigReport({ homeDir: home, cwd: project, env: { PI_BUDGET_TOKENS: "abc", PI_BUDGET_MINUTES: "9" } });
    expect(report.config).toEqual({ limits: { usd: 2, toolCalls: 7, minutes: 9 }, warnAt: 0.8, onExceed: "warn" });
    expect(report.unusable).toBe(false);
    expect(report.problems).toHaveLength(2);
    expect(report.problems.join("\n")).toMatch(/unknown key "bogus".*"turns"/s);
    expect(report.problems.join("\n")).toMatch(/PI_BUDGET_TOKENS/);
  });

  it("flags an unreadable source as unusable and keeps the other layers", () => {
    writeJson(home, "{not json");
    const report = loadConfigReport({ homeDir: home, env: { PI_BUDGET_USD: "2" } });
    expect(report.unusable).toBe(true);
    expect(report.config.limits).toEqual({ usd: 2 });
    expect(report.config.onExceed).toBe("stop");
    expect(report.problems[0]).toMatch(/invalid JSON in .*budget\.json/);
    writeJson(home, []);
    expect(loadConfigReport({ homeDir: home, env: {} }).unusable).toBe(true);
  });

  it("a bad project file is unusable but cannot loosen anything", () => {
    writeJson(home, { limits: { usd: 2 } });
    writeJson(project, "nope");
    const report = loadConfigReport({ homeDir: home, cwd: project, env: {} });
    expect(report.unusable).toBe(true);
    expect(report.config.limits).toEqual({ usd: 2 });
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

  it("does not resolve prototype keys", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "__PROTO__"]) {
      expect(resolveLimitKey(name)).toBeUndefined();
    }
  });

  it("parses numeric strings", () => {
    expect(parseLimitValue("usd", " 2.5 ")).toBe(2.5);
    expect(() => parseLimitValue("usd", "")).toThrow();
    expect(() => parseLimitValue("usd", "Infinity")).toThrow();
  });

  it("accepts plain decimal strings only", () => {
    expect(parseLimitValue("tokens", "1e3")).toBe(1000);
    expect(parseLimitValue("minutes", "0.5")).toBe(0.5);
    for (const bad of ["0x10", "0b11", "0o7", "0X1F", "-5", "+5", ".5", "5.", "1_000", "1 000", "1e", "NaN"]) {
      expect(() => parseLimitValue("tokens", bad), bad).toThrow(/positive number/);
    }
    expect(() => validateLayer({ limits: { tokens: "0x10" } }, "x")).toThrow(/"tokens"/);
    expect(() => layerFromEnv({ PI_BUDGET_TOKENS: "0b11" })).toThrow(/PI_BUDGET_TOKENS/);
  });

  it("rejects non-decimal warnAt strings", () => {
    expect(parseWarnAt("0.5")).toBe(0.5);
    for (const bad of ["0x1", "0b1", "0o1", "+1", ".5", "1.", "", "NaN"]) {
      expect(() => parseWarnAt(bad), bad).toThrow(/warnAt/);
    }
  });
});
