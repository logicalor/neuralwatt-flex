# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
