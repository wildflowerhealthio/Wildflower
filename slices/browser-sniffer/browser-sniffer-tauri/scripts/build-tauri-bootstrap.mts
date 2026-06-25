// Build-time bundler for the Tauri sniffer bootstrap: bundles
// `src/tauri-sniffer-entry.ts` (the shim + `installSniffer()` invocation) as a
// self-contained IIFE via the shared `buildBootstrap` helper. See
// `build-bootstrap.mts` for the outputs written and why.
//
// CI's `tauri` lint/test job runs `pnpm install` (which triggers this via
// `prepare`) before `cargo build`/`cargo nextest`, so the latest bytes are
// always compiled in. Rust-only PRs that don't need a fresh bootstrap fall back
// to a stub written by the workflow, just so `include_str!` resolves.

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
