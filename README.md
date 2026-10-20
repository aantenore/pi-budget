# pi-budget

**Hard limits for Pi: stop runaway agents before they burn your budget.**

[![CI](https://github.com/aantenore/pi-budget/actions/workflows/ci.yml/badge.svg)](https://github.com/aantenore/pi-budget/actions/workflows/ci.yml)
![limits](https://img.shields.io/badge/limits-USD%20·%20tokens%20·%20turns%20·%20tool%20calls%20·%20time-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

An agent stuck in a loop at 3 a.m. does not stop on its own. Pi has no built-in spend cap, and before this package
none of the community packages enforced one per session.

`pi-budget` is a [Pi](https://pi.dev) package that enforces spend, token, turn, tool-call and wall-time limits on the coding agent, plus a small helper for apps built on `@earendil-works/pi-agent-core`.

## Quickstart

```bash
pi install npm:@aantenore/pi-budget
pi --budget-usd 2 --budget-turns 30
```

Pi now stops the run when the session has spent $2, or when a single agent run reaches 30 turns. A status line shows live usage (`$0.12/$2.00 · 4/30 turns`), and `/budget` shows the details.

## See it work

Real runs of the Pi CLI (1.3.0) with a local `gemma4:12b` through Ollama, asked to read six files one by one:

```text
$ pi -p --budget-turns 2 "Read each of the six note files one at a time, then list all six secret words."
[pi-budget] Budget: reached turns limit (2/2 turns). Stopping the run.

$ pi -p --budget-tokens 3000 "Read each of the six note files one at a time, then list all six secret words."
[pi-budget] Budget: reached tokens limit (3.2k/3k tok). Stopping the run.

$ pi -p --budget-turns 2 --budget-on-exceed warn "Read note1.txt and note2.txt, then tell me both secret words."
[pi-budget] Budget: reached turns limit (2/2 turns).
The secret words are item1 and item2.
```

Every stop is also written to the session as an audit entry:
`{"customType":"pi-budget","data":{"limit":"turns","used":2,"max":2,"at":"…"}}`.

## Limits

| Limit | Meaning | Scope | Config file key | Env var | CLI flag |
|---|---|---|---|---|---|
| `usd` | Cost in USD, as computed by Pi from the model's price table | session | `limits.usd` | `PI_BUDGET_USD` | `--budget-usd` |
| `tokens` | Input + output + cache read + cache write tokens | session | `limits.tokens` | `PI_BUDGET_TOKENS` | `--budget-tokens` |
| `inputTokens` | Input-side tokens: input + cache read + cache write | session | `limits.inputTokens` | - | - |
| `outputTokens` | Output tokens | session | `limits.outputTokens` | - | - |
| `turns` | Completed model turns | agent run | `limits.turns` | `PI_BUDGET_TURNS` | `--budget-turns` |
| `toolCalls` | Tool calls | agent run | `limits.toolCalls` | `PI_BUDGET_TOOL_CALLS` | `--budget-tool-calls` |
| `minutes` | Wall-clock minutes | agent run | `limits.minutes` | `PI_BUDGET_MINUTES` | `--budget-minutes` |
| `warnAt` | Fraction of a limit that triggers a warning (`0 < x <= 1`, default `0.8`) | - | `warnAt` | `PI_BUDGET_WARN_AT` | - |
| `onExceed` | `stop` (default) or `warn` | - | `onExceed` | `PI_BUDGET_ON_EXCEED` | `--budget-on-exceed` |

A limit is reached when `used >= max`. All limits are optional; unset means unlimited. Values must be positive; token and count limits must be whole numbers. Strings from environment variables and flags must be plain decimals (`2.5`, `1e6`); hex, binary, octal and signed forms are rejected.

### Precedence

Lowest to highest: built-in defaults, `~/.pi/budget.json`, environment variables, CLI flags. Layers are merged key by key. The project file `<project>/.pi/budget.json` is applied last, but it can only **tighten** the result:

- each limit is the lower of the value from the layers above and the project value; the project may add a limit you did not set, but never raise one;
- `onExceed` can be changed from `warn` to `stop` by the project, never from `stop` to `warn`;
- `warnAt` from the project applies only if it is lower than the current value.

The project file lives in the repository you are working on and is read without Pi's project-trust check, so a cloned repository must not be able to switch your budget off or relax it. It can still make it stricter.

```json
{
  "limits": { "usd": 5, "tokens": 2000000, "turns": 50, "minutes": 30 },
  "warnAt": 0.8,
  "onExceed": "stop"
}
```

Unknown keys and invalid values are reported with an error that names the file, variable or flag. Only the invalid keys are dropped; every valid key of every layer still applies, so a typo never turns enforcement off. If a whole source cannot be loaded (unreadable file, invalid JSON, not an object) and `onExceed` is `stop`, pi-budget refuses to start runs and blocks tool calls until the file is fixed and the session reloaded (`/budget` shows why). Setting `onExceed` to `warn` explicitly in a valid layer turns that refusal into a warning.

### Scopes

- **Session** (`usd`, `tokens`, `inputTokens`, `outputTokens`): cumulative over the whole session. When a session starts or is resumed, totals are rebuilt from the session entries the same way Pi computes its own session stats: assistant message usage, tool-result usage, `usage` entries, and usage recorded on compaction and branch-summary entries. Resuming an exhausted session keeps it exhausted.
- **Agent run** (`turns`, `toolCalls`, `minutes`): counted from the first `agent_start` of a run until the run settles, then reset. A run is one prompt together with everything Pi continues inside it (automatic retries, compaction, queued follow-ups); those continuations do not restart the counters. Turns that ended in an error or were aborted are not counted. Between runs these limits show `0/N`, so changing one with `/budget set` while idle never reports an exceed.

### Local and unpriced models

Models without a price table (most local models) report a cost of $0, so a `usd` limit never triggers. pi-budget warns once when it sees tokens with zero cost while a `usd` limit is set. Use `tokens`, `inputTokens` or `outputTokens` for those models.

## What happens at a limit

- **Warning** (at `warnAt`, once per limit): a warning notification.
- **Exceeded, `onExceed: stop`** (once per limit): the run is aborted, an error notification is shown, further tool calls in that run are blocked with an explanatory reason, and an audit entry is appended to the session: custom type `pi-budget` with `{ limit, used, max, at }`. A new prompt in a session whose `usd` or token budget is already exhausted is stopped immediately.
- **Exceeded, `onExceed: warn`**: a warning notification only. Nothing is aborted or blocked.

Without a UI (print mode), messages go to stderr instead of notifications.

## Commands

```
/budget                       show usage versus limits
/budget set usd 5             change a limit for the current session
/budget set tool-calls off    remove a limit
```

Limit names: `usd`, `tokens`, `input-tokens`, `output-tokens`, `turns`, `tool-calls`, `minutes`. Changes apply to the running session only and are not saved; they are discarded when a session starts, resumes or reloads.

## SDK usage (pi-agent-core)

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import { budgetHooks } from "@aantenore/pi-budget";

const budget = budgetHooks(
  { limits: { usd: 2, turns: 30 }, onExceed: "stop" },
  { onCrossing: (c) => console.error(`budget ${c.type}: ${c.limit} ${c.used}/${c.max}`) },
);

const agent = new Agent({
  // ...your options
  finishTurn: budget.finishTurn,         // ends the run once a limit is reached
  beforeToolCall: budget.beforeToolCall, // blocks tools once a limit is reached
  prepareRequest: budget.prepareRequest, // refuses the provider request when the budget is already exhausted
});
agent.subscribe(budget.observe);         // required: resets run counters, records usage
```

`prepareRequest` runs before every provider request. When a limit is already exceeded in `stop` mode it throws; pi-agent-core (1.3.0) catches that, records an error assistant message carrying the budget reason, ends the run, and never calls the provider, so a run started on an exhausted budget costs nothing. Without it, the first request of such a run is still sent. Usage is ingested on `message_end`, so `beforeToolCall` already sees the usage of the turn that issued the call. After a run ends, the run-scoped counters (`turns`, `toolCalls`, `minutes`) read 0 again; read them from `onCrossing` or during the run.

`budget.tracker` exposes the current state (`tracker.format()`, `tracker.used("usd")`, `tracker.state()`). If you already define `finishTurn` or `beforeToolCall`, call the budget hook first and keep its decision when it returns one. In the SDK, `minutes` is checked at turn boundaries and before tool calls; there is no timer, so a single long provider request is not interrupted (use `onCrossing` with `agent.abort()` if you need that).

Run scope: in the SDK the application decides what a run is. Each `agent.prompt()` or explicit `agent.continue()` starts a new run for the run-scoped limits (`turns`, `toolCalls`, `minutes`), while session-scoped limits (`usd`, `tokens`) accumulate across runs.

The pure pieces are also exported: `BudgetTracker`, `loadConfig`, `validateLayer`, `totalsFromEntries`.

## How it works

The extension (`dist/extensions/budget.js`, declared in the `pi` manifest) uses these Pi events:

| Event | Use |
|---|---|
| `session_start` | Load configuration, rebuild session totals from entries |
| `agent_start` | First start of a run: reset run counters, start the wall-time timer (continuations inside the same run are ignored) |
| `turn_end` | Re-read session entries (picks up assistant and tool-result usage), count the turn, enforce |
| `tool_call` | Re-read session entries, count the call; block it once a limit is exceeded or when enforcement fails in `stop` mode |
| `session_compact`, `session_tree` | Re-read session entries (compaction and branch-summary usage) |
| `agent_settled`, `session_shutdown` | Stop the timer, end the run and clear its counters |

Session totals are always recomputed from the session entries rather than added up incrementally, so nothing is counted twice.

## Limitations

- Limits are checked after each turn, not while a response streams. The turn that crosses a limit is paid for in full, so `usd` and token limits can be overshot by one turn.
- Reaching the `toolCalls` limit lets that last call run; the run is aborted at the end of the turn. Calls beyond the limit in the same batch are blocked.
- Usage added to the session by other extensions is picked up at the next tool call, turn end, compaction or tree navigation, not instantly.
- Session totals include every entry in the session file, including other branches, which matches how Pi reports session stats.
- `tokens` includes cache reads and writes, matching Pi's session total. Use `outputTokens` if cached input should not count.
- `/budget set` is not persisted.
- The project file `<project>/.pi/budget.json` is read without consulting Pi's project-trust setting; it can only tighten the budget (see Precedence).
- Audit entries are only written in `stop` mode.
- Verified against `@earendil-works/pi-coding-agent` 1.3.0 with a scripted (faux) provider and a hand-written host. Not verified against real provider responses or the interactive terminal UI.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Requires Node.js >= 22.19.

## License

MIT
