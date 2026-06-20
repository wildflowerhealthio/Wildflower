/**
 * Shared in-page "browser chrome" top bar for Tauri webviews that load
 * arbitrary pages.
 *
 * Factored out of the browser-sniffer bootstrap so both the sniffer and the
 * sandboxed-webview (apps launch) bootstrap inject the same bar. A Tauri
 * `WebviewWindow` presents on mobile as a full-screen native screen with no
 * visible browser chrome, so this fixed bar is the user's only "I'm somewhere
 * else, I can go back / dismiss" affordance.
 *
 * Designed for arbitrary third-party pages — see the browser-sniffer
 * Architecture Explanation for the design constraints this inherits:
 *   - **CSP-safe styling.** Styles are set via the CSSOM (`element.style.*`,
 *     `setProperty`), never the `style=""` attribute or a `<style>` element, so
 *     a page's `style-src` CSP can't strip them (the spec gate only covers the
 *     attribute/element string forms, not CSSOM API mutations).
 *   - **Shadow isolation.** Structure lives in a `closed` shadow root, so page
 *     CSS can't reach in and our styles can't be `!important`-overridden from
 *     outside.
 *   - **Self-healing.** A `MutationObserver` re-attaches the host if a hostile
 *     page strips foreign DOM.
 *
 * Best-effort throughout — never throws into the page.
 */

/** What the leading button does. */
type PrimaryAction =
  | 'back' // a back chevron: history-back while possible, else `onExit`
  | 'close' // a Close button: `onExit` immediately

interface BrowserTopBarOptions {
  /**
   * DOM id of the injected host element. Distinct per context so two bars
   * (sniffer + sandbox) never collide, and so each context's tests/teardown
   * can find their own host.
   */
  readonly hostId: string
  /**
   * Registry-symbol slot on `globalThis` where the self-heal observer is
   * stashed, so re-injection (and tests) can disconnect the prior one.
   */
  readonly observerSlotKey: symbol
  /** Leading button behaviour — see {@link PrimaryAction}. */
  readonly primary: PrimaryAction
  /**
   * Invoked when the bar resolves to "leave this view": Close clicked, or Back
   * tapped with no history left. The caller emits the appropriate host signal
   * (sniffer: `SniffingComplete`; sandbox: `CloseSandboxedWebView`).
   */
  readonly onExit: () => void
  /** Show a reload button (sandbox: yes; sniffer: no). */
  readonly showReload?: boolean
  /**
   * Reserve the bar's height by pushing page content down (so the bar doesn't
   * overlay the page). Best-effort: applied as `!important` padding on the root
   * element, which covers normal document-flow pages; a `100vh`-pinned layout
   * may still sit under the bar. The sniffer leaves this off (it intentionally
   * overlays the observed page).
   */
  readonly reserveSpace?: boolean
}

/** `globalThis` widened with an arbitrary symbol-keyed observer slot. */
type ObserverHost = typeof globalThis & {
  [key: symbol]: MutationObserver | undefined
}

/**
 * Inject the top bar at the top of the current page. Idempotent: a second call
 * for the same `hostId` returns early. See {@link BrowserTopBarOptions}.
 */
function injectBrowserTopBar(options: BrowserTopBarOptions): void {
  const { hostId, observerSlotKey, primary, onExit } = options
  const showReload = options.showReload ?? false
  const reserveSpace = options.reserveSpace ?? false

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- widen globalThis with a symbol-keyed observer slot; mirrors the sniffer's WithObserverSlot pattern.
  const slot = globalThis as ObserverHost
  const doc = document
  // Re-injection on the same page (or a second bootstrap pass) reuses the
  // existing host — skip the shadow-DOM cost.
  if (doc.getElementById(hostId) !== null) return

  /** Read the current location host (falling back to href), guarding teardown. */
  const currentLabel = (): string => {
    // jsdom can null out `globalThis.location` during teardown; guard so the
    // self-healing observer doesn't throw after the window's already gone.
    const loc = globalThis.location as Location | undefined
    if (loc === undefined) return ''
    return loc.host || loc.href
  }

  /** Back chevron behaviour: navigate back while possible, else leave. */
  const goBack = (): void => {
    const history = globalThis.history as History | undefined
    // `history.length > 1` is the only portable "can I go back?" signal; it can
    // over-count across redirects, but the worst case is one extra back step
    // before the next tap exits — acceptable for a v1 affordance.
    if (history !== undefined && history.length > 1) {
      history.back()
      return
    }
    onExit()
  }

  /** Reload the current page. */
  const reload = (): void => {
    const loc = globalThis.location as Location | undefined
    loc?.reload()
  }

  /** A pill/chrome button styled via the CSSOM (CSP-safe). */
  const makeButton = (text: string, ariaLabel: string, onClick: () => void): HTMLButtonElement => {
    const button = doc.createElement('button')
    button.type = 'button'
    button.textContent = text
    button.setAttribute('aria-label', ariaLabel)
    button.style.display = 'inline-flex'
    button.style.alignItems = 'center'
    button.style.justifyContent = 'center'
    button.style.minWidth = '44px'
    button.style.minHeight = '44px' // iOS HIG tap-target floor
    button.style.padding = '0 12px'
    button.style.border = '0'
    button.style.borderRadius = '10px'
    button.style.background = 'rgba(0,0,0,0.05)'
    button.style.color = 'inherit'
    button.style.font = 'inherit'
    button.style.fontSize = '18px'
    button.style.lineHeight = '1'
    button.style.cursor = 'pointer'
    button.addEventListener('click', onClick)
    return button
  }

  // Mutable handle to the URL pill so popstate/hashchange can refresh it.
  let urlPill: HTMLSpanElement | undefined

  const refreshLabel = (): void => {
    if (urlPill !== undefined) urlPill.textContent = currentLabel()
  }

  /** Reserve the bar's height by padding the document root. Best-effort. */
  const applyReservedSpace = (host: HTMLElement): void => {
    if (!reserveSpace) return
    const apply = (): void => {
      const height = host.offsetHeight
      if (height <= 0) return
      // CSSOM mutation (not the style attribute) — CSP-safe, same as above.
      // `!important` resists a page that resets root padding.
      doc.documentElement.style.setProperty('padding-top', `${height}px`, 'important')
    }
    apply()
    // Keep the reserved space in sync as the safe-area inset settles or the bar
    // wraps. `ResizeObserver` is absent in some old/test envs — degrade to the
    // one-shot measurement above.
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        apply()
      })
      observer.observe(host)
    }
  }

  const attach = (): void => {
    if (doc.body === null) return
    const host = doc.createElement('div')
    host.id = hostId
    // Inline styles via the CSSOM (not `setAttribute('style', …)`) bypass the
    // page's `style-src` CSP — see the module header.
    host.style.position = 'fixed'
    host.style.top = '0'
    host.style.left = '0'
    host.style.right = '0'
    host.style.zIndex = '2147483647'
    host.style.pointerEvents = 'none' // wrapper passes through; inner controls catch
    const shadow = host.attachShadow({ mode: 'closed' })

    // Light "browser toolbar" chrome inside the closed shadow root.
    const bar = doc.createElement('div')
    bar.style.display = 'flex'
    bar.style.alignItems = 'center'
    bar.style.gap = '8px'
    bar.style.padding = `calc(env(safe-area-inset-top, 0px) + 8px) 12px 8px 12px`
    bar.style.background = 'rgba(246, 246, 247, 0.96)'
    bar.style.color = '#1c1c1e'
    bar.style.font = '500 13px/1.2 -apple-system, system-ui, sans-serif'
    bar.style.pointerEvents = 'auto'
    bar.style.boxShadow = '0 1px 0 rgba(0,0,0,0.08), 0 2px 10px rgba(0,0,0,0.10)'

    // Leading button: a back chevron or a Close button.
    const leading =
      primary === 'back'
        ? makeButton('‹', 'Go back', goBack)
        : makeButton('Close', 'Close', onExit)
    bar.append(leading)

    if (showReload) {
      bar.append(makeButton('⟳', 'Reload', reload))
    }

    // URL pill — a rounded address-bar-like field showing the current host.
    const pill = doc.createElement('span')
    pill.style.flex = '1 1 auto'
    pill.style.minWidth = '0'
    pill.style.overflow = 'hidden'
    pill.style.textOverflow = 'ellipsis'
    pill.style.whiteSpace = 'nowrap'
    pill.style.padding = '8px 12px'
    pill.style.borderRadius = '10px'
    pill.style.background = '#ffffff'
    pill.style.border = '1px solid rgba(0,0,0,0.12)'
    pill.style.color = '#3a3a3c'
    urlPill = pill
    refreshLabel()
    globalThis.addEventListener('popstate', refreshLabel)
    globalThis.addEventListener('hashchange', refreshLabel)
    bar.append(pill)

    shadow.append(bar)
    doc.body.append(host)
    applyReservedSpace(host)
  }

  const attachWhenReady = (): void => {
    if (doc.body === null) {
      // `DOMContentLoaded` fires once `<body>` exists.
      doc.addEventListener('DOMContentLoaded', attachWhenReady, { once: true })
      return
    }
    attach()
    // Self-heal: a page that strips foreign DOM (rare — anti-extension pages do
    // this) would yank the host. Watch for removal and re-attach. The prior
    // observer is disconnected first so at most one is alive per page.
    slot[observerSlotKey]?.disconnect()
    const observer = new MutationObserver(() => {
      try {
        if (doc.documentElement === null) {
          observer.disconnect()
          return
        }
        if (doc.getElementById(hostId) === null) {
          attach()
        }
      } catch {
        // Window/document may be partially torn down between fire and dispatch;
        // nothing to recover, just stop observing.
        observer.disconnect()
      }
    })
    observer.observe(doc.body, { childList: true })
    slot[observerSlotKey] = observer
  }

  attachWhenReady()
}

export { injectBrowserTopBar }
export type { BrowserTopBarOptions, PrimaryAction }
