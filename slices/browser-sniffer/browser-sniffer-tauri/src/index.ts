import { tauriSnifferBootstrapScript } from './tauri-bootstrap.generated.ts'

/**
 * Self-invoking JS source of the Tauri sniffer bootstrap, produced at
 * build time by `scripts/build-tauri-bootstrap.mts`. The Rust slice
 * `browser-sniffer-tauri-rust` embeds the same bytes via `include_str!`
 * and hands them to `WebviewBuilder::initialization_script(...)` — this
 * TS export exists for tests, devtools, and any non-Rust consumer.
 *
 * The bundle does four things, in order, conditional on
 * `window.__TAURI__.event` being present:
 *   1. Emits sniffer messages on the single multiplexed `BRIDGE_EVENT`
 *      Tauri channel with the message's `_tag` field as the dispatch
 *      discriminator. The host-side `makeTauriTransport` listens on
 *      the same channel and demuxes by `_tag`; per-tag listeners would
 *      let Tauri re-order events across tags (FIFO is only guaranteed
 *      within a single event name).
 *   2. Attaches one `event.listen(BRIDGE_EVENT, …)` listener that
 *      filters payloads by `_tag` (`Click` / `CancelSnifferRequest`)
 *      and reacts in-place — `Click` runs `document.querySelector`
 *      then `.click()`, `CancelSnifferRequest` cancels the in-flight
 *      request id and emits a terminal `Cancelled`.
 *   3. Injects an in-page `BrowserTopBar` (closed shadow DOM, Close
 *      button + URL label) so the sniffer webview reads as a
 *      sub-context on iOS where there's no native browser chrome.
 *      The fetch/XHR shims skip Tauri-internal IPC URLs at the source,
 *      so that traffic is never sniffed in the first place.
 *   4. Invokes `installSniffer()` with a filter-wrapped event bus that
 *      serializes outbound emits (and drops Tauri's own IPC-fallback
 *      console warning) to preserve FIFO across Tauri's IPC fallback
 *      dance.
 *
 * When `__TAURI__` is absent the whole shim no-ops (no fetch/XHR/console
 * wrapping) — the bootstrap has nowhere to send sniffer traffic, so
 * mutating the page would be wasted work.
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
