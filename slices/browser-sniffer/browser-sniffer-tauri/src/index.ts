import { tauriSnifferBootstrapScript } from './tauri-bootstrap.generated.ts'

/**
 * Self-invoking JS source of the Tauri sniffer bootstrap, produced at
 * build time by `scripts/build-tauri-bootstrap.mts`. The Rust slice
 * `browser-sniffer-tauri-rust` embeds the same bytes via `include_str!`
 * and hands them to `WebviewBuilder::initialization_script(...)` — this
 * TS export exists for tests, devtools, and any non-Rust consumer.
 *
 * The bundle does three things, in order:
 *   1. Replaces `window.ReactNativeWebView.postMessage` with a Tauri
 *      `event.emit('bridge:{tag}', payload)` shim — the only outbound
 *      channel the unmodified `installSniffer()` uses.
 *   2. Attaches Tauri `event.listen('bridge:Click' | 'bridge:CancelSnifferRequest')`
 *      handlers that dispatch synthetic `window` `message` events with
 *      `source: null` (the channel the sniffer's host-message handler
 *      reads — see `install-sniffer.ts:589-628`).
 *   3. Invokes `installSniffer()` exactly as the Expo arm does.
 *
 * Length guard: an empty or stale generated file is a build-step bug.
 * Anything below ~1000 chars almost certainly means the esbuild step
 * did not run; surface it loudly instead of silently injecting a no-op.
 */
const TAURI_SNIFFER_BOOTSTRAP_MIN_LENGTH = 1000
if (tauriSnifferBootstrapScript.length < TAURI_SNIFFER_BOOTSTRAP_MIN_LENGTH) {
  throw new Error(
    `browser-sniffer-tauri: tauriSnifferBootstrapScript is ${tauriSnifferBootstrapScript.length} chars, ` +
      `expected at least ${TAURI_SNIFFER_BOOTSTRAP_MIN_LENGTH}. ` +
      `The generated file 'tauri-bootstrap.generated.ts' looks empty or stale — ` +
      `run \`vp run generate-tauri-bootstrap\` to regenerate it. ` +
      `Script preview: ${tauriSnifferBootstrapScript.slice(0, 200)}`
  )
}

export { tauriSnifferBootstrapScript }
