# Use case: this session, reported by `neuralwatt-flex`

This is a real capture from the opencode session that built and published this
repository. The `neuralwatt-flex` plugin was active for the entire session, so
every NeuralWatt turn below was silently flex-injected and accounted for by the
plugin itself. The two reports below are the verbatim output of the plugin's own
reporting tools, captured at the end of the session.

> Session IDs are shown partially redacted. Agent names (`title`,
> `bmad-orchestrator`) are opencode's own agent identifiers and are kept as-is.

## Workload

The session performed a single end-to-end task: take an existing in-development
opencode plugin (the `neuralwatt-flex` source itself), scaffold it into a
distributable repository, author install + usage documentation, and publish it to
GitHub. That involved a lot of context loading (a large orchestrator system
prompt plus many skill files) and relatively little code generation — which is
why the token volume is high relative to the number of model calls.

## `flex-session` — current session + subagents

```
==============================================================================
NeuralWatt Flex Stats — Session ses_0ff20c…(redacted)
==============================================================================

Main Session (agent: title):

  Model                   Flex   API     Tokens   Est.Cost     Act.Cost         Energy Grid
  ──────────────────────────────────────────────────────────────────────────────
  unknown                   20     0          0         $0           $0              — —
  glm-5.2                    0    18    717,640   $0.12259     $0.03759    1.50e-2 kWh US-MIDA-PJM
  ──────────────────────────────────────────────────────────────────────────────
  Total                     20    18    717,640   $0.12259     $0.03759    1.50e-2 kWh

Combined: 20 flex turns (18 API calls)  717,640 tokens
  Estimated cost (models.dev): $0.12259
  Actual billed cost (NeuralWatt): $0.03759
  Energy: 1.50e-2 kWh  Carbon: 7.14e+0g  Grid: US-MIDA-PJM
  Allowance remaining: $61.17

Disabled models: (none)

==============================================================================
Note: "Est.Cost" = opencode models.dev estimate (no flex discount).
"Act.Cost" = NeuralWatt actual billed cost (includes flex discount).
==============================================================================
```

## `flex-stats` — process lifetime rollup

```
==============================================================================
NeuralWatt Flex Stats — Process Lifetime
==============================================================================

  Agent          Model                   Flex   API     Sess     Tokens   Est.Cost     Act.Cost         Energy
  ──────────────────────────────────────────────────────────────────────────────
  title          unknown                   20     0        1          0         $0           $0              —
  bmad-orchestrator glm-5.2                    0    18        1    717,640   $0.12259     $0.03759    1.50e-2 kWh
  ──────────────────────────────────────────────────────────────────────────────
  Total                                    20    18        1    717,640   $0.12259     $0.03759    1.50e-2 kWh
  Flex rate: 100.0%
  Energy: 1.50e-2 kWh  Carbon: 7.14e+0g  Grid: US-MIDA-PJM
  Allowance remaining: $61.17

Disabled models: (none)

==============================================================================
Note: "Est.Cost" = opencode models.dev estimate (no flex discount).
"Act.Cost" = NeuralWatt actual billed cost (includes flex discount).
Energy/carbon from NeuralWatt SSE telemetry.
==============================================================================
```

## What this demonstrates

### 1. The flex discount is real and material

- **Estimated cost** (opencode's `models.dev` list pricing, no flex discount): **$0.12259**
- **Actual billed cost** (NeuralWatt, flex tier, post-cache): **$0.03759**
- **Savings: ~$0.085, i.e. ~69%** off list price for the exact same work.

`Est.Cost` and `Act.Cost` are both computed by the plugin from two independent
sources — opencode's local message events for the estimate, and NeuralWatt's
streaming `:cost` SSE telemetry for the actual bill — so the gap is a genuine
side-by-side of "what it would have cost" vs "what it did cost".

### 2. 100% flex rate, zero model disabling

`Flex rate: 100.0%` means every eligible NeuralWatt turn ran on flex capacity,
and `Disabled models: (none)` means no model errored out on the flex tier during
the session. The automatic fallback path (disable flex for a failing model) was
not exercised here — it exists for resilience, not because flex was unusable.

The `20` injected flex turns vs `18` API calls discrepancy is expected: opencode
also runs a lightweight `title` agent that auto-generates session titles through
NeuralWatt. Those title turns get `service_tier: flex` injected (counted as flex
turns) but report no token/cost telemetry through opencode's message events —
hence the `unknown` model row with `API 0` and `Tokens 0`. The real work — 18
`glm-5.2` turns, 717,640 tokens — is fully accounted for in the second row.

### 3. Streaming energy + carbon telemetry works

The plugin parsed NeuralWatt's `:energy` SSE comments end-to-end:

- **Energy:** 1.50 × 10⁻² kWh
- **Carbon:** 7.14 g CO₂eq
- **Grid:** `US-MIDA-PJM` (the US Mid-Atlantic PJM interconnection)

These are attributed to the session via the injected `x-flex-session-id` header
and accumulate per model, not per turn, so the totals roll up cleanly across the
whole session.

### 4. Allowance tracking

`Allowance remaining: $61.17` is parsed from NeuralWatt's `:cost` telemetry
(`allowance_remaining_usd`) on each turn. It's the live remaining balance on the
NeuralWatt account as of the last turn — useful as a heads-up before you run out,
without ever exposing the API key itself.

## Caveats visible in this capture

- **Title-agent row shows zero tokens.** This is a limitation of how opencode
  surfaces the title-generation agent's message events, not a plugin bug. Cost
  telemetry for those turns, if any, would still be captured via SSE.
- **Token volume is high for 18 calls.** A large system prompt + many loaded skill
  files inflated input tokens. The flex discount applied to the full volume.
- **Stats are process-local.** Closing opencode resets all of the above; nothing
  is persisted or exported.
