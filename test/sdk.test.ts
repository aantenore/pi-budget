import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  streamSimple,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { budgetHooks } from "../src/sdk.js";
import type { Crossing } from "../src/types.js";
import { usage } from "./helpers/entries.js";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  while (registrations.length > 0) registrations.pop()?.unregister();
});

function setup(hooks: ReturnType<typeof budgetHooks>, responses: Parameters<FauxProviderRegistration["setResponses"]>[0]) {
  const faux = registerFauxProvider();
  registrations.push(faux);
  faux.setResponses(responses);
  const executed: string[] = [];
  const echo: AgentTool<any, undefined> = {
    name: "echo",
    label: "Echo",
    description: "Echo the text",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } as any,
    execute: async (_id, args) => {
      const { text } = args as { text: string };
      executed.push(text);
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
  const agent = new Agent({
    streamFn: streamSimple,
    initialState: { systemPrompt: "test", model: faux.getModel(), thinkingLevel: "off", tools: [echo] },
    finishTurn: hooks.finishTurn,
    beforeToolCall: hooks.beforeToolCall,
  });
  agent.subscribe(hooks.observe);
  return { agent, faux, executed };
}

const call = (text: string) => fauxToolCall("echo", { text });

describe("budgetHooks with a real Agent and the faux provider", () => {
  it("ends the run via finishTurn once the token limit is exceeded", async () => {
    const hooks = budgetHooks({ limits: { tokens: 1 } });
    const { agent, faux, executed } = setup(hooks, [
      fauxAssistantMessage(call("one")),
      fauxAssistantMessage(call("two")),
      fauxAssistantMessage("done"),
    ]);
    await agent.prompt("go");
    expect(faux.state.callCount).toBe(1);
    expect(executed).toEqual(["one"]); // the tool of the exceeding turn already ran
    expect(hooks.tracker.isExceeded()).toBe(true);
    expect(hooks.tracker.used("turns")).toBe(1);
  });

  it("lets a run finish when it stays under the limits", async () => {
    const hooks = budgetHooks({ limits: { tokens: 1_000_000, turns: 10 } });
    const { agent, faux } = setup(hooks, [fauxAssistantMessage(call("one")), fauxAssistantMessage("done")]);
    await agent.prompt("go");
    expect(faux.state.callCount).toBe(2);
    expect(hooks.tracker.used("turns")).toBe(2);
    expect(hooks.tracker.isExceeded()).toBe(false);
  });

  it("blocks tool calls beyond the tool-call limit with a clear reason", async () => {
    const hooks = budgetHooks({ limits: { toolCalls: 1 } });
    const { agent, executed } = setup(hooks, [
      fauxAssistantMessage([call("first"), call("second")]),
      fauxAssistantMessage("done"),
    ]);
    const results: string[] = [];
    agent.subscribe((event: AgentEvent) => {
      if (event.type === "tool_execution_end") results.push(JSON.stringify(event.result));
    });
    await agent.prompt("go");
    expect(executed).toEqual(["first"]);
    expect(results.some((r) => r.includes("Budget exceeded") && r.includes("tool-calls 1/1 tools"))).toBe(true);
  });

  it("does not end or block in warn mode", async () => {
    const crossings: Crossing[] = [];
    const hooks = budgetHooks({ limits: { tokens: 1, toolCalls: 1 }, onExceed: "warn" }, { onCrossing: (c) => crossings.push(c) });
    const { agent, faux, executed } = setup(hooks, [
      fauxAssistantMessage([call("a"), call("b")]),
      fauxAssistantMessage("done"),
    ]);
    await agent.prompt("go");
    expect(faux.state.callCount).toBe(2);
    expect(executed).toEqual(["a", "b"]);
    expect(crossings.filter((c) => c.type === "exceed").map((c) => c.limit).sort()).toEqual(["tokens", "toolCalls"]);
  });

  it("resets run-scoped counters on each prompt and keeps session usage", async () => {
    const hooks = budgetHooks({ limits: { tokens: 1_000_000, turns: 5 } });
    const { agent, faux } = setup(hooks, [fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
    await agent.prompt("first");
    const tokensAfterFirst = hooks.tracker.used("tokens");
    expect(hooks.tracker.used("turns")).toBe(1);
    await agent.prompt("second");
    expect(faux.state.callCount).toBe(2);
    expect(hooks.tracker.used("turns")).toBe(1);
    expect(hooks.tracker.used("tokens")).toBeGreaterThan(tokensAfterFirst);
  });
});

describe("budgetHooks with simulated events", () => {
  const turnOf = (cost: number, toolCost?: number) => ({
    message: { role: "assistant", content: [], usage: usage({ input: 10, output: 5, cost }) },
    toolResults: toolCost === undefined ? [] : [{ role: "toolResult", usage: usage({ cost: toolCost }) }],
  });
  const asTurn = (t: ReturnType<typeof turnOf>) => ({ ...t, context: {}, newMessages: [] }) as any;

  it("ends the run when usd is exceeded, counting assistant and tool-result usage", async () => {
    const hooks = budgetHooks({ limits: { usd: 1 } });
    hooks.observe({ type: "agent_start" });
    expect(await hooks.finishTurn(asTurn(turnOf(0.4, 0.1)), undefined)).toBeUndefined();
    expect(hooks.tracker.used("usd")).toBeCloseTo(0.5);
    expect(await hooks.finishTurn(asTurn(turnOf(0.4, 0.2)), undefined)).toEqual({ action: "end" });
    expect(await hooks.beforeToolCall({} as any)).toMatchObject({ block: true, terminate: true });
  });

  it("counts a turn once when both finishTurn and the turn_end event deliver it", async () => {
    const hooks = budgetHooks({ limits: { usd: 10, turns: 10 } });
    hooks.observe({ type: "agent_start" });
    const t = turnOf(0.25);
    await hooks.finishTurn(asTurn(t), undefined);
    hooks.observe({ type: "turn_end", message: t.message as any, toolResults: [] });
    expect(hooks.tracker.used("usd")).toBeCloseTo(0.25);
    expect(hooks.tracker.used("turns")).toBe(1);
  });

  it("counts usage from turn_end alone when finishTurn is not wired", () => {
    const hooks = budgetHooks({ limits: { usd: 10 } });
    hooks.observe({ type: "turn_end", message: turnOf(0.5).message as any, toolResults: [] });
    expect(hooks.tracker.used("usd")).toBeCloseTo(0.5);
  });

  it("enforces wall time at turn boundaries using the injected clock", async () => {
    let now = 0;
    const crossings: Crossing[] = [];
    const hooks = budgetHooks({ limits: { minutes: 2 } }, { clock: () => now, onCrossing: (c) => crossings.push(c) });
    hooks.observe({ type: "agent_start" });
    now = 100_000;
    expect(await hooks.finishTurn(asTurn(turnOf(0)), undefined)).toBeUndefined();
    expect(crossings.map((c) => c.type)).toEqual(["warn"]);
    now = 121_000;
    expect(await hooks.finishTurn(asTurn(turnOf(0)), undefined)).toEqual({ action: "end" });
    expect(crossings.map((c) => c.type)).toEqual(["warn", "exceed"]);
  });

  it("rejects an invalid config", () => {
    expect(() => budgetHooks({ limits: { usd: -1 } })).toThrow(/"usd"/);
  });
});
