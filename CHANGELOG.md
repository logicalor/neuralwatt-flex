# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-22

### Changed
- **Ported to the OpenCode V2 plugin API.** V1 plugin implementations do not run in OpenCode V2; the entrypoint is now a `Plugin.define`-style default export (`{ id, setup(ctx) }`) with a root-level `server.ts` package entry, which is how V2 resolves local plugin directories.
- Flex injection now uses V2 session hooks: `ctx.session.hook("context" | "compaction" | "generate", ...)` sets the `service_tier` provider option, and an `http.request` hook enforces `service_tier: "flex"` on the final request body plus the `x-flex-session-id` correlation header.
- Telemetry capture moved from a `globalThis.fetch` patch to the native `ctx.session.hook("http.response", ...)` hook (tee'd SSE stream parsing, same `:energy`/`:cost` comment format).
- Per-turn accounting moved from V1 `message.updated` deltas to V2 `session.step.ended` / `session.step.failed` events; flex-tier error fallback listens to step/execution failures.
- The `flex-session` / `flex-stats` tools are registered through `ctx.tool.transform` (JSON Schema inputs, `codemode: false` so agents see them directly).
- Subagent discovery uses `ctx.session.list({ parentID })` instead of the V1 client `session.children` API.
- Typechecking now uses `@opencode/plugin` (V2 SDK, replaces `@opencode-ai/plugin`).

### Fixed
- Flex injection no longer depends on provider-option lowering: the `http.request` hook guarantees `service_tier` reaches the request body even when the protocol drops unknown options.

## [0.1.0] - 2026-06-26

### Added
- Initial public release of the `neuralwatt-flex` opencode plugin.
- Single-file TypeScript plugin (`src/neuralwatt-flex.ts`) with no build step — loaded directly by opencode.
- Fetch interception of `api.neuralwatt.com/chat/completions` calls, injecting `service_tier: "flex"` so eligible turns transparently run on cheaper, lower-priority flex capacity.
- `x-flex-session-id` correlation header so NeuralWatt SSE telemetry can be attributed back to the originating opencode session.
- Streaming `:energy` / `:cost` SSE comment parsing for per-turn energy (joules, kWh, carbon gCO2eq, grid id) and cost (request cost, cache savings, allowance remaining) telemetry.
- Per-session and process-lifetime accounting: flex-injected turns, skipped turns, API calls, token breakdown (input / output / reasoning / cache read / cache write), estimated cost (models.dev) vs actual billed cost (NeuralWatt, post-flex discount), energy and carbon totals.
- Two reporting tools: `flex-session` (current session + all subagent child sessions) and `flex-stats` (process-lifetime rollup by agent × model).
- Automatic graceful fallback: if a model errors on the flex tier, the plugin disables flex injection for that model so subsequent turns proceed normally.
- Install scaffolding: `package.json` (npm-from-git ready), `tsconfig.json` (strict), `.gitignore`, and an `example/opencode.jsonc`.
- Documentation: this `README.md`, `LICENSE` (MIT), and a real-session use-case report under `docs/use-cases/`.
