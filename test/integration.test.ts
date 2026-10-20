import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderRegistration, fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  type ExtensionAPI,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import budget from "../extensions/budget.js";

let root: string;
let faux: FauxProviderRegistration | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-budget-int-"));
  mkdirSync(join(root, "agent"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
});

afterEach(() => {
  faux?.unregister();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

interface Run {
  callCount: number;
  notifications: { message: string; level: string | undefined }[];
  statuses: (string | undefined)[];
  entries: any[];
  roles: string[];
}

/** Drive a real AgentSession (in-memory, faux provider) with the extension loaded as an inline factory. */
async function runSession(
  responses: Parameters<FauxProviderRegistration["setResponses"]>[0],
  prompts = 1,
  extraExtensions: ((pi: ExtensionAPI) => void)[] = [],
): Promise<Run> {
  faux = registerFauxProvider();
  const model = faux.getModel();
  faux.setResponses(responses);

  const agentDir = join(root, "agent");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    apiKey: "faux-key",
    api: faux.api,
    models: faux.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: m.api,
      reasoning: m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      baseUrl: m.baseUrl,
    })),
  } as any);

  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [budget, ...extraExtensions],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory(),
  });

  const notifications: Run["notifications"] = [];
  const statuses: Run["statuses"] = [];
  const ui = new Proxy(
    {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    } as Record<string, unknown>,
    { get: (target, key: string) => (key in target ? target[key] : () => undefined) },
  );
  try {
    await session.bindExtensions({ uiContext: ui as any, mode: "rpc" });
    for (let i = 0; i < prompts; i++) await session.prompt(`go ${i}`);
    const entries = session.sessionManager.getEntries() as any[];
    return {
      callCount: faux.state.callCount,
      notifications,
      statuses,
      entries,
      roles: entries.filter((e) => e.type === "message").map((e) => e.message.role),
    };
  } finally {
    session.dispose();
  }
}

const toolTurn = () => fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }));

describe("real Pi session with the faux provider", () => {
  it("stops a run at the turn limit and records an audit entry", async () => {
    vi.stubEnv("PI_BUDGET_TURNS", "2");
    const run = await runSession([toolTurn(), toolTurn(), toolTurn(), fauxAssistantMessage(fauxText("done"))]);
    expect(run.callCount).toBe(2);
    const audit = run.entries.filter((e) => e.type === "custom" && e.customType === "pi-budget");
    expect(audit).toHaveLength(1);
    expect(audit[0].data).toMatchObject({ limit: "turns", used: 2, max: 2 });
    expect(run.notifications.some((n) => n.level === "error" && /turns limit/.test(n.message))).toBe(true);
    expect(run.statuses).toContain("2/2 turns!");
    expect(run.statuses.at(-1)).toBe("0/2 turns"); // run counters are cleared once the run settles
  });

  it("stops on a session token limit", async () => {
    vi.stubEnv("PI_BUDGET_TOKENS", "1");
    const run = await runSession([toolTurn(), toolTurn(), fauxAssistantMessage(fauxText("done"))]);
    expect(run.callCount).toBe(1);
    expect(run.entries.some((e) => e.type === "custom" && e.customType === "pi-budget" && e.data.limit === "tokens")).toBe(true);
  });

  it("blocks tool calls beyond the tool-call limit within a batch and stops after it", async () => {
    vi.stubEnv("PI_BUDGET_TOOL_CALLS", "1");
    const run = await runSession([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo a" }), fauxToolCall("bash", { command: "echo b" })]),
      toolTurn(),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const results = run.entries.filter((e) => e.type === "message" && e.message.role === "toolResult").map((e) => e.message);
    expect(results).toHaveLength(2);
    expect(results.filter((m) => m.isError && JSON.stringify(m.content).includes("Budget exceeded"))).toHaveLength(1);
    expect(run.callCount).toBe(1);
  });

  it("lets warn mode run to completion", async () => {
    vi.stubEnv("PI_BUDGET_TURNS", "1");
    vi.stubEnv("PI_BUDGET_ON_EXCEED", "warn");
    const run = await runSession([toolTurn(), fauxAssistantMessage(fauxText("done"))]);
    expect(run.callCount).toBe(2);
    expect(run.entries.some((e) => e.type === "custom" && e.customType === "pi-budget")).toBe(false);
    expect(run.notifications.some((n) => n.level === "warning" && /turns limit/.test(n.message))).toBe(true);
  });

  it("resets per-run limits on the next prompt", async () => {
    vi.stubEnv("PI_BUDGET_TURNS", "2");
    const run = await runSession([fauxAssistantMessage(fauxText("a")), fauxAssistantMessage(fauxText("b"))], 2);
    expect(run.callCount).toBe(2);
    expect(run.notifications.filter((n) => n.level === "error")).toEqual([]);
  });

  it("keeps counting turns across continuations inside one run and triggers the cap", async () => {
    vi.stubEnv("PI_BUDGET_TURNS", "3");
    let continuations = 0;
    // Each pass of agent_before_settle makes Pi continue the same run, which emits agent_start again.
    const continueTwice = (pi: ExtensionAPI) => {
      pi.on("agent_before_settle", () => {
        if (continuations >= 3) return undefined;
        continuations++;
        return { continue: true, entries: [{ type: "custom_message", customType: "more", content: "continue", display: false }] };
      });
    };
    const run = await runSession(
      [
        fauxAssistantMessage(fauxText("a")),
        fauxAssistantMessage(fauxText("b")),
        fauxAssistantMessage(fauxText("c")),
        fauxAssistantMessage(fauxText("d")),
      ],
      1,
      [continueTwice],
    );
    expect(run.callCount).toBe(3);
    const audit = run.entries.filter((e) => e.type === "custom" && e.customType === "pi-budget");
    expect(audit).toHaveLength(1);
    expect(audit[0].data).toMatchObject({ limit: "turns", used: 3, max: 3 });
  });
});
