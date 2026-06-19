// Entry point bundled by `scripts/build-tauri-bootstrap.mts` into the
// IIFE injected into Tauri sniffer webviews via
// `initialization_script(...)`. Looks up Tauri's event API, injects the
// in-page `BrowserTopBar`, and hands the bus to `installSniffer`.
//
// `window.__TAURI__` is present because `tauri.conf.json` sets
// `app.withGlobalTauri: true`, which Tauri prepends to every webview's
// init scripts at runtime — no per-builder opt-in needed.

import type { TauriEventApi } from 'effect-messaging-tauri'

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
  // Wrap the raw Tauri event bus once and share the wrapper between the
  // top bar and the sniffer install, so both the top bar's
  // `SniffingComplete` and the sniffer's stream ride the same outbound
  // ordering chain (and the same Tauri IPC-fallback-warning filter).
  const filteredEvent = makeFilteringEventBus(event)

  // A persistent in-page top bar so the sniffer reads as a sub-context
  // on platforms (notably iOS) where a Tauri WebviewWindow presents as
  // a full-screen native screen with no visible browser chrome. See
  // `injectBrowserTopBar` for the design constraints — shadow-DOM
  // isolation, JS-style mutations (CSP-safe), self-healing against
  // pages that strip foreign DOM.
  injectBrowserTopBar(filteredEvent)

  // Without a working Tauri event bus the bootstrap can't carry any
  // sniffer traffic — gating `installSniffer()` here keeps an arbitrary
  // page free of fetch/XHR/console wrappers it can never observe.
  installSniffer(filteredEvent)
}

/**
 * Inject a fixed-position top bar at the top of the page with a Close
 * button (which emits `SniffingComplete` on the bridge channel) and the
 * current page URL. It looks like the top bar of a browser, hence the
 * name — the
 * sniffer webview itself has no native browser chrome on mobile, so
 * this is the user's only "I'm somewhere else, I can dismiss" signal.
 *
 * Designed for arbitrary third-party pages — see the Architecture
 * Explanation doc for the design constraints (CSP, page CSS clobbering,
 * iOS safe-area, etc.).
 *
 * Returns nothing — best-effort, never throws into the page.
 */
function injectBrowserTopBar(eventBus: TauriEventApi): void {
  const HOST_ID = 'wildflower-sniffer-browser-top-bar'
  const OBSERVER_SLOT = Symbol.for('browser-sniffer-tauri:top-bar-observer')
  type WithObserverSlot = typeof globalThis & { [OBSERVER_SLOT]?: MutationObserver }
  const slot = globalThis as WithObserverSlot
  const doc = document
  // If a prior init-script pass already attached a host, reuse it —
  // skips the shadow-DOM cost on re-injection.
  if (doc.getElementById(HOST_ID) !== null) return

  const attachWhenReady = (): void => {
    if (doc.body === null) {
      // `DOMContentLoaded` fires once `<body>` exists.
      doc.addEventListener('DOMContentLoaded', attachWhenReady, { once: true })
      return
    }
    attach()
    // Self-heal: a page that strips foreign DOM (rare — anti-extension
    // pages do this) would yank the host. Watch for removal and
    // re-attach. `doc` is the closed-over reference captured at boot so
    // the observer survives `globalThis.document` going away (e.g. a
    // jsdom env tearing down between test files). The observer is
    // stashed in a Symbol-keyed slot so tests (and a future explicit
    // teardown path) can disconnect it; on re-injection we disconnect
    // the prior observer to keep at most one alive per page.
    slot[OBSERVER_SLOT]?.disconnect()
    const observer = new MutationObserver(() => {
      try {
        if (doc.documentElement === null) {
          observer.disconnect()
          return
        }
        if (doc.getElementById(HOST_ID) === null) {
          attach()
        }
      } catch {
        // Window/document may be partially torn down between fire and
        // dispatch; nothing to recover, just stop observing.
        observer.disconnect()
      }
    })
    observer.observe(doc.body, { childList: true })
    slot[OBSERVER_SLOT] = observer
  }

  const attach = (): void => {
    if (doc.body === null) return
    const host = doc.createElement('div')
    host.id = HOST_ID
    // Inline styles via DOM API (not `setAttribute('style', …)`) bypass
    // the page's `style-src` CSP — the spec-level CSP gate only covers
    // `<style>` elements and the HTML `style=""` attribute, not direct
    // `element.style` property mutation.
    host.style.position = 'fixed'
    host.style.top = '0'
    host.style.left = '0'
    host.style.right = '0'
    host.style.zIndex = '2147483647'
    host.style.pointerEvents = 'none' // wrapper passes through; only inner controls catch
    const shadow = host.attachShadow({ mode: 'closed' })

    // Style + structure inside the closed shadow root. Page CSS can't
    // reach in, and our DOM-API styles can't be `!important`-overridden
    // by anything outside the shadow.
    const bar = doc.createElement('div')
    bar.style.display = 'flex'
    bar.style.alignItems = 'center'
    bar.style.gap = '12px'
    bar.style.padding = `calc(env(safe-area-inset-top, 0px) + 8px) 12px 8px 12px`
    bar.style.background = 'rgba(20, 22, 28, 0.92)'
    bar.style.color = '#f4f4f5'
    bar.style.font = '500 13px/1.2 -apple-system, system-ui, sans-serif'
    bar.style.pointerEvents = 'auto'
    bar.style.boxShadow = '0 1px 0 rgba(255,255,255,0.08), 0 4px 12px rgba(0,0,0,0.18)'

    const close = doc.createElement('button')
    close.type = 'button'
    close.textContent = 'Close'
    close.setAttribute('aria-label', 'Close sniffer')
    close.style.minWidth = '64px'
    close.style.minHeight = '44px' // iOS HIG tap-target floor
    close.style.padding = '0 14px'
    close.style.border = '0'
    close.style.borderRadius = '8px'
    close.style.background = 'rgba(255,255,255,0.14)'
    close.style.color = 'inherit'
    close.style.font = 'inherit'
    close.style.cursor = 'pointer'
    close.addEventListener('click', () => {
      // Best-effort emit on the multiplexed bridge channel.
      // SniffingComplete carries an empty struct on the wire beyond
      // the `_tag` discriminator; Rust-side `handle_sniffing_complete`
      // ignores the payload shape.
      void eventBus.emit(BRIDGE_EVENT, { _tag: 'SniffingComplete' })
    })

    const label = doc.createElement('span')
    label.style.flex = '1 1 auto'
    label.style.overflow = 'hidden'
    label.style.textOverflow = 'ellipsis'
    label.style.whiteSpace = 'nowrap'
    label.style.opacity = '0.85'
    const refreshLabel = (): void => {
      // jsdom can null out `globalThis.location` during teardown; guard
      // so the self-healing observer doesn't throw after the window's
      // already gone.
      const loc = win.location as Location | undefined
      if (loc === undefined) return
      label.textContent = loc.host || loc.href
    }
    refreshLabel()
    win.addEventListener('popstate', refreshLabel)
    win.addEventListener('hashchange', refreshLabel)

    bar.append(close, label)
    shadow.append(bar)
    doc.body.append(host)
  }

  attachWhenReady()
}
