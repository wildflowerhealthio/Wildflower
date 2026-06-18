// Entry point used by `scripts/build-tauri-bootstrap.mts` to produce
// the self-invoking IIFE injected into Tauri sniffer webviews via
// `WebviewWindowBuilder::initialization_script(...)`. The bundle adapts
// the unmodified `installSniffer()`'s outbound channel
// (`window.ReactNativeWebView.postMessage(jsonStr)`) onto Tauri's
// per-tag event bus (`bridge:{tag}` — the same convention pinned by
// `effect-messaging-tauri/event-names.ts`), then invokes the sniffer.
//
// `window.__TAURI__` is present inside the sniffer webview because the
// app's `tauri.conf.json` sets `app.withGlobalTauri: true`, which Tauri
// codegen prepends to every webview's init-script list at runtime — no
// per-builder opt-in is needed.
//
// Outbound: `window.ReactNativeWebView.postMessage(jsonStr)` — the
// sniffer's only outbound channel — JSON-parses and emits
// `bridge:{_tag}` with the structured payload. The main webview's
// `makeTauriTransport` listener for that tag receives it directly:
// Tauri events broadcast to every listener, so no Rust-side forwarding
// is needed for the data plane.
//
// Inbound: `BrowserSnifferBridge.HostToWeb` declares `Click` and
// `CancelSnifferRequest`. We listen on the matching Tauri events and
// dispatch a synthetic `window` `message` event with `source: null`
// (set explicitly — the spec default is `null`, but documenting the
// contract here removes any engine-quirk footgun) — exactly the channel
// the sniffer's `addEventListener('message', …)` handler reads.

import type { UnlistenFn } from '@tauri-apps/api/event'

import { installSniffer } from 'browser-sniffer-injected'

interface TauriEventEnvelope<T = unknown> {
  readonly payload: T
}

interface TauriEventApi {
  readonly emit: (event: string, payload?: unknown) => Promise<void>
  readonly listen: <T = unknown>(
    event: string,
    handler: (event: TauriEventEnvelope<T>) => void
  ) => Promise<UnlistenFn>
}

interface TauriGlobals {
  readonly event?: TauriEventApi
}

interface SnifferWindowExtensions {
  ReactNativeWebView?: {
    postMessage(data: string): void
  }
  __TAURI__?: TauriGlobals
}

// Symbol-keyed slot for the pending unlisten functions registered by
// the previous run of this script. The init script re-runs on every
// navigation inside the sniffer webview, so without cleanup the
// Rust-side listener registry would grow unbounded — each
// `event.listen(...)` allocates a fresh listener ID and the old IDs
// would dispatch into the new page's JS context where they no longer
// resolve. We drain this slot before re-registering. `Symbol.for`
// keeps slots we own off the global string-key namespace where they
// could collide with anything the page declares.
const UNLISTEN_SLOT = Symbol.for('browser-sniffer-tauri:unlisten')

type UnlistenStash = Array<UnlistenFn | Promise<UnlistenFn>>
type WindowWithUnlistenSlot = typeof globalThis & {
  [UNLISTEN_SLOT]?: UnlistenStash
}

const win = globalThis as typeof globalThis & SnifferWindowExtensions
// oxlint-disable-next-line no-underscore-dangle -- `__TAURI__` is the Tauri 2 globals namespace.
const event = win.__TAURI__?.event

if (event !== undefined) {
  // Drain any unlistens left over from a previous page in this webview.
  // `event.listen` returns Promise<UnlistenFn>; the previous run may have
  // stashed promises that haven't resolved yet (the `await`-less style
  // we use below). Resolve-then-call handles both shapes.
  const slot = win as WindowWithUnlistenSlot
  const priorUnlistens = slot[UNLISTEN_SLOT] ?? []
  for (const entry of priorUnlistens) {
    void Promise.resolve(entry).then((unlisten) => {
      unlisten()
    })
  }
  const pendingUnlistens: UnlistenStash = []
  slot[UNLISTEN_SLOT] = pendingUnlistens

  // Outbound: replace `window.ReactNativeWebView.postMessage` (the
  // sniffer's only outbound channel) with a Tauri-event emitter. The
  // sniffer always calls `JSON.stringify(msg)` before posting, so
  // JSON.parse round-trips the structured message we hand to
  // `event.emit` — letting `makeTauriTransport`'s `Schema.typeSchema`
  // decode on the main side without any string envelope.
  win.ReactNativeWebView = {
    postMessage(jsonStr: string): void {
      let parsed: unknown
      try {
        parsed = JSON.parse(jsonStr)
      } catch {
        // The sniffer's `post()` always emits valid JSON-stringified
        // structs; a parse failure here means the contract has drifted.
        // Drop silently — there is no transport to surface this on yet.
        return
      }
      if (parsed === null || typeof parsed !== 'object' || !('_tag' in parsed)) return
      const tag = (parsed as { _tag: unknown })._tag
      if (typeof tag !== 'string') return
      void event.emit(`bridge:${tag}`, parsed)
    },
  }

  // Inbound: `BrowserSnifferBridge.hostToWeb` declares exactly these two
  // tags. Keep the list inline — adding a third tag here without adding
  // it to the bridge schema (or vice versa) is a drift caught by the
  // tests in `tests/bootstrap.test.ts`.
  const inboundTags = ['Click', 'CancelSnifferRequest'] as const
  for (const tag of inboundTags) {
    const promise = event.listen(`bridge:${tag}`, ({ payload }) => {
      // `source: null` explicit so the sniffer's `event.source !== null`
      // drop guard always passes — engine quirks aside.
      const data = JSON.stringify(payload)
      win.dispatchEvent(new MessageEvent('message', { data, source: null }))
    })
    pendingUnlistens.push(promise)
  }

  // A persistent in-page top bar so the sniffer reads as a sub-context
  // on platforms (notably iOS) where a Tauri WebviewWindow presents as
  // a full-screen native screen with no visible browser chrome. See
  // `injectBrowserTopBar` for the design constraints — shadow-DOM
  // isolation, JS-style mutations (CSP-safe), self-healing against
  // pages that strip foreign DOM.
  injectBrowserTopBar(event)

  // Without a working Tauri event bus the bootstrap can't carry any
  // sniffer traffic — gating `installSniffer()` here keeps an arbitrary
  // page free of fetch/XHR/console wrappers it can never observe.
  installSniffer()
}

/**
 * Inject a fixed-position top bar at the top of the page with a Close
 * button (which emits `bridge:SniffingComplete`) and the current page
 * URL. It looks like the top bar of a browser, hence the name — the
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
    // jsdom env tearing down between test files).
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
      // Best-effort emit. SniffingComplete carries an empty struct on
      // the wire; Rust-side `handle_sniffing_complete` ignores the
      // payload shape.
      void eventBus.emit('bridge:SniffingComplete', { _tag: 'SniffingComplete' })
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
