/**
 * OpenCode V2 plugin entrypoint.
 *
 * V2 resolves a local plugin directory through `<dir>/server.*` (then
 * `<dir>/index.*`), not through package.json `exports`, so this file is the
 * package's server entry. The implementation lives in src/.
 */
export { default } from "./src/neuralwatt-flex.ts"
