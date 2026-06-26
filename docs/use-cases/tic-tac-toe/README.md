# Use case: a multi-agent tic-tac-toe build, reported by `neuralwatt-flex`

This is a real capture from an opencode session that built a small, dependency-free
tic-tac-toe web app end-to-end. The `neuralwatt-flex` plugin was active for the
entire session, so every NeuralWatt turn below was silently flex-injected and
accounted for by the plugin itself. The two reports below are the verbatim output
of the plugin's own reporting tools, captured immediately after the app was written
and verified.

> Session IDs are shown partially redacted. Agent names (`bmad-orchestrator`,
> `bmad-dev`) are opencode's own agent identifiers, and the leading model names
> (`neuralwatt/glm-5.2`, `moonshotai/Kimi-K2.7-Code`) are the full provider/model
> identifiers from NeuralWatt's catalog. Both are kept as-is.

## Workload

The task was a single self-contained artifact: a one-file `index.html` tic-tac-toe
app, plain HTML/CSS/JS, no framework, no dependencies, no CDN, no build step. The
spec required a clean separation of pure game-state logic (a `createGame()`
factory exposing `board()`, `currentPlayer()`, `winner()`, `winningLine()`,
`isDraw()`, `makeMove(index)`, `reset()`) from DOM rendering, plus win detection
on every row, column, and both diagonals, draw detection, a post-win / post-draw
click guard, and a reset button — with a Node-friendly export convention
(`module.exports` when `module` is present, `window.createGame` + DOM bootstrap
otherwise) so the same file could be tested headlessly by extracting its
`<script>` block.

The orchestrator (agent `bmad-orchestrator`, model `neuralwatt/glm-5.2`) routed
the work to a `bmad-dev` subagent (model `moonshotai/Kimi-K2.7-Code`) running in
a sandboxed child session. The subagent wrote the app — 294 lines including markup,
styles and logic. The orchestrator then ran `node` against a 23-check verification
harness (`/tmp/opencode/ttt-verify.js`) covering fresh-state invariants, turn
switching, the occupied-cell guard, row/column/main-diagonal/anti-diagonal wins,
post-win click guard, reset, and draw. All 23 checks passed; no source-code fixes
were needed after the subagent's first pass.

## `flex-session` — current session + subagents

```
==============================================================================
NeuralWatt Flex Stats — Session ses_0fed5…(redacted)
==============================================================================

Main Session (agent: bmad-orchestrator):

  Model                      API     Tokens   Est.Cost     Act.Cost         Energy Grid
  ──────────────────────────────────────────────────────────────────────────────
  glm-5.2                      8    247,673   $0.10649     $0.01642    6.56e-3 kWh US-MIDA-PJM
  ──────────────────────────────────────────────────────────────────────────────
  Total                        8    247,673   $0.10649     $0.01642    6.56e-3 kWh

Subagents (1 child sessions):

  Session              Agent          Model                      API     Tokens     Act.Cost         Energy
  ──────────────────────────────────────────────────────────────────────────────
  ses_0fed4…(redacted) bmad-dev       moonshotai/Kimi-K2.7-Code     6    157,532     $0.02167    8.67e-3 kWh
  ──────────────────────────────────────────────────────────────────────────────
  Subtotal                                                         6    157,532     $0.02167    8.67e-3 kWh

Combined: 14 turns (405,205 tokens)
  Flex:        14 turns  405,205 tokens   Est $0.15926   Billed $0.03809
  Non-flex:    0 turns  0 tokens   Est $0   Billed $0
  Estimated cost (models.dev): $0.15926
  Actual billed cost (NeuralWatt): $0.03809
  Energy: 1.52e-2 kWh  Carbon: 3.42e+0g  Grid: FI
  Allowance remaining: $60.39

Disabled models: (none)

==============================================================================
Note: "Flex" = runs on flex capacity (discounted). "[std]" = non-flex fallback runs.
"Est.Cost" = opencode models.dev estimate (list price). "Billed" = NeuralWatt actual.
==============================================================================
```

## `flex-stats` — process lifetime rollup

```
==============================================================================
NeuralWatt Flex Stats — Process Lifetime
==============================================================================

  Agent          Model                      API     Sess     Tokens   Est.Cost     Act.Cost         Energy
  ──────────────────────────────────────────────────────────────────────────────
  bmad-orchestrator glm-5.2                      8        1    247,673   $0.10649     $0.01642    6.56e-3 kWh
  bmad-dev       moonshotai/Kimi-K2.7-Code     6        1    157,532   $0.05277     $0.02167    8.67e-3 kWh
  ──────────────────────────────────────────────────────────────────────────────
  Total                                      14        2    405,205   $0.15926     $0.03809    1.52e-2 kWh
  Flex rate: 100.0%  (14 flex / 0 non-flex turns)
  Flex billed: $0.03809   Non-flex billed: $0
  Energy: 1.52e-2 kWh  Carbon: 3.42e+0g  Grid: FI
  Allowance remaining: $60.39

Disabled models: (none)

==============================================================================
Note: "Flex" = runs on flex capacity (discounted). "[std]" = non-flex fallback runs.
"Est.Cost" = opencode models.dev estimate (list price). "Act.Cost" = NeuralWatt actual.
Energy/carbon from NeuralWatt SSE telemetry.
==============================================================================
```

## What this demonstrates

### 1. Per-agent, per-model attribution across orchestrator and subagent

The session involved two different agents running two different models:

- `bmad-orchestrator` (the main opencode session) on `neuralwatt/glm-5.2` — 8 API
  calls, 247,673 tokens. This is the orchestration overhead: loading the large
  orchestrator system prompt, planning the task, invoking the subagent, reading
  the rebuilt artifact, running the verify harness, and capturing the two reports.
- `bmad-dev` (a sandboxed child session) on `moonshotai/Kimi-K2.7-Code` — 6 API
  calls, 157,532 tokens. This is the actual code-writing work.

The plugin attributes both correctly: the main session shows `glm-5.2` only, the
subagent row is labelled with its own agent name and model, and the `flex-stats`
rollup lists two distinct `Agent × Model` rows rather than collapsing them. The
correlation between them is the `x-flex-session-id` header the plugin injects on
every NeuralWatt turn, which is what lets `flex-session` present the subagent as a
child session of the main one.

### 2. The flex discount is real and material, with per-model variation

Across the whole session:

- **Estimated cost** (opencode's `models.dev` list pricing, no flex discount):
  **$0.15926**
- **Actual billed cost** (NeuralWatt, flex tier, post-cache):
  **$0.03809**
- **Savings: ~$0.121, i.e. ~76%** off list price for the same work.

`Est.Cost` and `Act.Cost` come from two independent sources — opencode's local
message events for the estimate, NeuralWatt's streaming `:cost` SSE telemetry for
the actual bill — so the gap is a genuine side-by-side of "what it would have cost"
vs "what it did cost".

The discount is not uniform across models:

- `glm-5.2`: Est $0.10649 → Act $0.01642, **~85% off** list.
- `Kimi-K2.7-Code`: Est $0.05277 → Act $0.02167, **~59% off** list.

The per-model differential is what makes the per-model breakdown worth printing
rather than just a single "you saved $X" total. Different models flex-discount at
different rates depending on NeuralWatt's own pricing tiers and capacity, and a
workload that mixes models can't be reduced to one number.

### 3. 100% flex rate, zero fallback, and the title agent is correctly excluded

`Flex rate: 100.0% (14 flex / 0 non-flex turns)` means every eligible NeuralWatt
turn ran on flex capacity. `Disabled models: (none)` means no model errored out on
the flex tier during the session — the automatic fallback path (disable flex for a
failing model) was not exercised; it exists for resilience, not because flex was
unusable.

The `14` flex turns exactly match the `8 + 6 = 14` API calls across the two
sessions, with no extra rows or token-zero placeholders. The plugin excludes the
lightweight `title` agent that opencode runs in the background to auto-generate
session titles — its turns are still flex-injected but they are not surfaced as a
separate row in the per-model or per-agent tables, so the visible counts reflect
only the work you'd care to read.

### 4. Streaming energy + carbon telemetry works end-to-end

The plugin parsed NeuralWatt's `:energy` SSE comments through the full session:

- **Energy:** 0.0152 kWh (1.52 × 10⁻² kWh)
- **Carbon:** 3.42 g CO₂eq
- **Grid:** `FI` (Finland)

The combined energy (0.0152 kWh) is split across the two model rows — 6.56 × 10⁻³
kWh on the orchestrator's model and 8.67 × 10⁻³ kWh on the subagent's — so you can
see which model contributed which share of the carbon. Telemetry is attributed via
the `x-flex-session-id` header and accumulates per model.

### 5. Allowance tracking

`Allowance remaining: $60.39` is parsed from NeuralWatt's `:cost` telemetry
(`allowance_remaining_usd`) on each turn. It is the live remaining balance on the
NeuralWatt account as of the last captured turn — a heads-up before you run out,
without ever exposing the API key itself.

## Caveats visible in this capture

- **Differentials between `Est.Cost` and `Act.Cost` vary by model.** The 76%
  session-wide savings figure is a weighted blend; per-model savings ranged from
  59% (`Kimi-K2.7-Code`) to 85% (`glm-5.2`). Treat the headline percentage as a
  rough guide, not a guaranteed rate for any future turn.
- **Carbon is grid-dependent.** The session landed on the Finnish grid (`FI`); the
  same energy on a dirtier grid would produce more grams of CO₂eq. The kWh value
  is the comparable quantity across grids; the gCO₂eq value is not.
- **`flex-session` shows `Act.Cost` only on the subagent row.** The combined totals
  immediately below include both estimates and actuals for the full session; use
  the combined rows for the side-by-side comparison.
- **Stats are process-local.** Closing opencode resets all of the above; nothing is
  persisted to disk or exported anywhere.
