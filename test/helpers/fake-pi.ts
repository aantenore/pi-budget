import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import budget from "../../extensions/budget.js";
import type { SessionEntryLike } from "../../src/entries.js";

type Handler = (event: any, ctx: any) => unknown;

export interface Harness {
  entries: SessionEntryLike[];
  appended: { type: string; data: any }[];
  notifications: { message: string; level: string | undefined }[];
  statuses: (string | undefined)[];
  abort: ReturnType<typeof vi.fn>;
  flags: Record<string, string | boolean | undefined>;
  registeredFlags: string[];
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  ctx: any;
  setIdle(value: boolean): void;
  emit(name: string, event?: Record<string, unknown>): Promise<any>;
  command(args: string): Promise<void>;
  lastStatus(): string | undefined;
  handlerCount(name: string): number;
}

export interface HarnessOptions {
  hasUI?: boolean;
  cwd?: string;
  flags?: Record<string, string | boolean | undefined>;
  entries?: SessionEntryLike[];
}

/** Hand-written stand-in for ExtensionAPI + ExtensionContext. Events are dispatched in registration order. */
export function createHarness(options: HarnessOptions = {}): Harness {
  const handlers = new Map<string, Handler[]>();
  const entries = options.entries ?? [];
  const appended: Harness["appended"] = [];
  const notifications: Harness["notifications"] = [];
  const statuses: Harness["statuses"] = [];
  const abort = vi.fn();
  const flags = { ...options.flags };
  const registeredFlags: string[] = [];
  const commands: Harness["commands"] = new Map();
  let idle = true;

  const ctx = {
    hasUI: options.hasUI ?? true,
    cwd: options.cwd ?? process.cwd(),
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    abort,
    isIdle: () => idle,
    signal: undefined,
  };

  const pi = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => undefined;
    },
    registerFlag: (name: string) => {
      registeredFlags.push(name);
    },
    getFlag: (name: string) => flags[name],
    registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
      commands.set(name, command);
    },
    appendEntry: (type: string, data: unknown) => {
      appended.push({ type, data });
    },
  };

  budget(pi as unknown as ExtensionAPI);

  return {
    entries,
    appended,
    notifications,
    statuses,
    abort,
    flags,
    registeredFlags,
    commands,
    ctx,
    setIdle: (value) => {
      idle = value;
    },
    async emit(name, event = {}) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        const out = await handler({ type: name, ...event }, ctx);
        if (out !== undefined && result === undefined) result = out;
      }
      return result;
    },
    command: (args) => commands.get("budget")!.handler(args, ctx),
    lastStatus: () => statuses[statuses.length - 1],
    handlerCount: (name) => handlers.get(name)?.length ?? 0,
  };
}
