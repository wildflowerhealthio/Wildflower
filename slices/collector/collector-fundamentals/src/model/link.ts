import type * as WebViewSource from './web-view-source.ts'

/**
 * A scripted navigation step. `Open` carries the same `WebViewSource`
 * shape the host uses for the initial `firstPage` so a slice's
 * `linkSequence` can mix inline HTML bootstraps and absolute `https://`
 * URIs without an extra translation layer. The Tauri host
 * (`browser-sniffer-tauri-rust`) maps `Link.Open` to an `OpenLink`
 * web→host message and navigates the existing sniffer `WebviewWindow`
 * to the new source.
 */
interface Open {
  readonly _tag: 'Open'
  readonly source: WebViewSource.Any
}

/**
 * A synthetic click. The Tauri host forwards this as a `ClickLink`
 * web→host message; the collector then re-emits it as a `Click`
 * host→web message on `BrowserSnifferBridge` so the injected sniffer
 * can run `document.querySelector(querySelector)?.click()` inside the
 * sniffed page. No "no match" feedback path — clicks are best-effort.
 */
interface Click {
  readonly _tag: 'Click'
  readonly querySelector: string
}

type Any = Open | Click

export type { Open, Click, Any }
