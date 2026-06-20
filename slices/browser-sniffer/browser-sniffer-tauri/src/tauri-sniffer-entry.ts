// Entry point bundled by `scripts/build-tauri-bootstrap.mts` into the IIFE
// injected into Tauri sniffer webviews via `initialization_script(...)`. Looks
// up Tauri's event API, injects the shared in-page browser top bar (configured
// with a Close button that ends sniffing), and hands the bus to `installSniffer`.
//
// `window.__TAURI__` is present because `tauri.conf.json` sets
// `app.withGlobalTauri: true`, which Tauri prepends to every webview's init
// scripts at runtime — no per-builder opt-in needed.

import type { TauriEventApi } from 'effect-messaging-tauri'
import { injectBrowserTopBar } from 'shared-structures-tauri/top-bar'

import { makeFilteringEventBus } from './filter-tauri-internal.ts'
import { BRIDGE_EVENT, installSniffer } from './install-sniffer.ts'

interface TauriGlobals {
  readonly event?: TauriEventApi
}

interface SnifferWindowExtensions {
  __TAURI__?: TauriGlobals
}

const win = globalThis as typeof globalThis & SnifferWindowExtensions
// oxlint-disable-next-line no-underscore-dangle -- `__TAURI__` is the Tauri 2 globals namespace.
const event = win.__TAURI__?.event

if (event !== undefined) {
  // Wrap the raw Tauri event bus once and share the wrapper between the top bar
  // and the sniffer install, so both the top bar's `SniffingComplete` and the
  // sniffer's stream ride the same outbound ordering chain (and the same Tauri
  // IPC-fallback-warning filter).
  const filteredEvent = makeFilteringEventBus(event)

  // A persistent in-page top bar so the sniffer reads as a sub-context on
  // platforms (notably iOS) where a Tauri WebviewWindow presents as a
  // full-screen native screen with no visible browser chrome. The shared bar
  // (`shared-structures-tauri/top-bar`) owns the CSP-safe, shadow-isolated,
  // self-healing injection; the sniffer configures it with a Close button that
  // emits `SniffingComplete` — its only "I'm done sniffing" affordance. The
  // host id and observer slot are pinned to the values the bootstrap test
  // (`tests/bootstrap.test.ts`) asserts.
  injectBrowserTopBar({
    hostId: 'wildflower-sniffer-browser-top-bar',
    observerSlotKey: Symbol.for('browser-sniffer-tauri:top-bar-observer'),
    primary: 'close',
    onExit: () => {
      // Best-effort emit on the multiplexed bridge channel. SniffingComplete
      // carries an empty struct beyond the `_tag` discriminator; Rust-side
      // `handle_sniffing_complete` ignores the payload shape.
      void filteredEvent.emit(BRIDGE_EVENT, { _tag: 'SniffingComplete' })
    },
  })

  // Without a working Tauri event bus the bootstrap can't carry any sniffer
  // traffic — gating `installSniffer()` here keeps an arbitrary page free of
  // fetch/XHR/console wrappers it can never observe.
  installSniffer(filteredEvent)
}
