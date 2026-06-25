# neuralwatt-flex

An [opencode](https://opencode.ai) plugin that silently routes your **NeuralWatt** traffic onto cheaper, lower-priority **flex** capacity whenever it's available, and gives you per-session reporting on usage, cost, energy and carbon.

It is a single TypeScript file with no build step and no network calls of its own. opencode loads it directly.

---

## What it does

When opencode sends a request to the NeuralWatt provider (`api.neuralwatt.com/chat/completions`), this plugin:

1. **Injects `service_tier: "flex"`** into the request body. Eligible turns then run on flex capacity at a discount instead of the standard tier — invisibly, with no change to your prompts or workflow.
2. **Tagging + teardown for telemetry.** It attaches an `x-flex-session-id` header so NeuralWatt's streaming telemetry can be correlated back to the opencode session that caused it, then parses the `:energy` and `:cost` SSE comment lines NeuralWatt emits alongside the streamed response.
3. **Aggregates everything** into per-session and per-model stats — flex turns, API calls, token breakdown, estimated vs actual cost, energy, carbon, grid id, and your remaining allowance — and exposes two tools you can call from chat (or from anywhere an opencode tool runs) to print a report.

If a model errors on the flex tier, the plugin **auto-disables** flex for that model and the turn proceeds on standard capacity. Nothing breaks; you just stop getting the discount for that model until the process restarts.

## Requirements

- A working [opencode](https://opencode.ai) install.
- A NeuralWatt provider configured in opencode with your own API key. **The plugin never reads, stores, or transmits your API key** — it only intercepts requests opencode is already making and adds the `service_tier` field + a correlation header. Your key stays in opencode's own provider config.

## Install

This repo is npm-ready but not published to the npm registry. Pick whichever form you prefer.

### Option A — clone + local path reference (recommended)

```bash
git clone https://github.com/logicalor/neuralwatt-flex.git ~/.config/opencode/plugins/neuralwatt-flex
```

Then add the plugin to your opencode config (`~/.config/opencode/opencode.json`, or `.opencode/opencode.json` in a project):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "./plugins/neuralwatt-flex/src/neuralwatt-flex.ts"
  ],
  "permission": {
    "tool": {
      "flex-session": "allow",
      "flex-stats": "allow"
    }
  }
}
```

Paths in the `plugin` array are resolved relative to the config file, so this mirrors where you cloned it. The `permission` block is optional — without it opencode will ask before each tool runs.

### Option B — install from GitHub as a package

```bash
npm install github:logicalor/neuralwatt-flex
```

Then reference the package by name (it ships the `.ts` entry, no compile needed):

```jsonc
{
  "plugin": ["neuralwatt-flex"]
}
```

## Configure

The only thing the plugin needs to function is a working NeuralWatt provider in opencode. Configure it like any other OpenAI-compatible provider (host `api.neuralwatt.com`, your API key in opencode's secrets, the models you want). Once the provider is reachable and you've installed the plugin as above, the next NeuralWatt turn will already be flex-injected and counted.

## Tools

The plugin exposes two read-only reporting tools. Neither makes network requests.

| Tool | Scope | Output |
|------|-------|--------|
| `flex-session` | The current session **and** all subagent child sessions | Per-model table for the main session, a per-model table for each subagent, combined totals, disabled models, and the last known allowance remaining. |
| `flex-stats` | Process lifetime (every session in this opencode process) | Rollup aggregated by **agent × model** with session counts and an overall flex rate (`flex turns / (flex turns + skipped turns)`). |

Both prints distinguish two cost figures:

- **Est.Cost** — what opencode estimates the turn cost using its own `models.dev` pricing. This does **not** include the flex discount, so it's an upper bound / "list price" view.
- **Act.Cost** — what NeuralWatt actually billed for the turn (parsed from its `:cost` SSE telemetry). This **does** include the flex discount, plus any prompt-cache savings. The gap between the two is your real savings.

Energy (kWh), carbon (gCO2eq) and grid id come from NeuralWatt's `:energy` SSE telemetry and are shown when available.

## Sample output

A trimmed `flex-session` report (real reports vary; see [`docs/use-cases/session-report.md`](docs/use-cases/session-report.md) for a genuine captured run):

```
==============================================================================
NeuralWatt Flex Stats — Session <session-id>
==============================================================================

Main Session (agent: bmad-orchestrator):

  Model                  Flex   API    Tokens   Est.Cost    Act.Cost        Energy Grid
  ─────────────────────────────────────────────────────────────────────────────────────
  neuralwatt/glm-5.2       12    12      8,421     $0.0143      $0.0091  3.40e-4 kWh WEU
  ─────────────────────────────────────────────────────────────────────────────────────
  Total                    12    12      8,421     $0.0143      $0.0091  3.40e-4 kWh

Combined: 12 flex turns (12 API calls)  8,421 tokens
  Estimated cost (models.dev): $0.0143
  Actual billed cost (NeuralWatt): $0.0091
  Energy: 3.40e-4 kWh  Carbon: 7.10e-2g  Grid: WEU
  Allowance remaining: $42.18

Disabled models: (none)

==============================================================================
Note: "Est.Cost" = opencode models.dev estimate (no flex discount).
"Act.Cost" = NeuralWatt actual billed cost (includes flex discount).
==============================================================================
```

## Notes & caveats

- **Flex is best-effort.** Flex capacity is lower-priority and can be unavailable or rejected for a given model. When a model errors on the flex tier, the plugin disables flex for it and subsequent turns proceed on standard capacity. Restart opencode to re-enable flex for disabled models.
- **Telemetry depends on the stream.** Energy/carbon/actual-cost rows come from SSE comment lines NeuralWatt emits during streaming. Non-streaming responses or provider quirkiness can mean those fields stay at zero for a turn; estimated cost and token counts still work because they come from opencode's own message events.
- **In-memory only.** Stats live in the opencode process. They are not persisted to disk and are not sent anywhere. Restart opencode and the counters reset.
- **Provider-scoped.** The plugin only acts on the NeuralWatt provider. Other providers in your opencode config are untouched.

## Privacy

- Does **not** read your API key, secrets, or env.
- Does **not** make any outbound network requests; it only wraps the `fetch` opencode already issues to NeuralWatt.
- Does **not** persist or transmit any usage data. Reporting happens locally, in-process, only when you call a tool.

## Development

No build. Typecheck against the plugin SDK:

```bash
npm install
npm run typecheck
```

The source is one file: [`src/neuralwatt-flex.ts`](src/neuralwatt-flex.ts).

## Use cases

- [`docs/use-cases/session-report.md`](docs/use-cases/session-report.md) — a real `flex-session` / `flex-stats` capture from the session that set up this repository.

## License

[MIT](LICENSE) © logicalor
