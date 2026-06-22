// Build-time bundler for the Tauri sniffer bootstrap.
//
// Bundles `src/tauri-sniffer-entry.ts` (the shim + `installSniffer()`
// invocation) as a self-contained IIFE via the shared `buildBootstrap` helper.
// Writes the result to two paths:
//   - `src/tauri-bootstrap.generated.ts` — `string` constant for the
//     TypeScript exports in `src/index.ts` (and the tests in `tests/`).
//     Lives under `src/` so the TS module resolver finds it under the
//     package's `customConditions: ['source']`.
//   - `dist/tauri-bootstrap.js` — raw IIFE that the Rust crate
//     `browser-sniffer-tauri-rust` includes via `include_str!`.
//
// Both outputs are gitignored. CI's `tauri` lint/test job runs
// `pnpm install` (which triggers this script via `prepare`) before
// `cargo build`/`cargo nextest`, so the latest bytes are always
// compiled in. Rust-only PRs that don't need a fresh bootstrap fall
// back to a stub written by the workflow, just so `include_str!`
// resolves at compile time.

import { resolve } from 'node:path'

import { buildBootstrap } from './build-bootstrap.mts'

// `import.meta.dirname` is a string by spec (Node 20.11+).
await buildBootstrap({
  pkgRoot: resolve(import.meta.dirname, '..'),
  entryFile: 'tauri-sniffer-entry.ts',
  constName: 'tauriSnifferBootstrapScript',
  outBaseName: 'tauri-bootstrap',
  scriptName: 'build-tauri-bootstrap.mts',
  regenerateScript: 'generate-tauri-bootstrap',
})
