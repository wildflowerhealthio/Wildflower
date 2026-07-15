import type { Duration } from 'effect'
import type * as WebViewSource from './web-view-source.ts'

/**
 * When the step machine should dispatch a step, relative to the
 * `PageLoaded` events flowing back from the sniffer.
 *
 * - Absent (`advanceWhen` omitted): the default — dispatch a fixed
 *   `ScrapingPlan.stepDelay` after each `PageLoaded`, matching the
 *   pre-existing behaviour (so plans that don't script a login, like
 *   the fhir-r4 collector, need no edits).
 * - `UrlMatch`: hold the step until a `PageLoaded` arrives whose `url`
 *   matches `pattern`, then dispatch after the usual `stepDelay` settle.
 *   Use for login flows whose redirects / SPA navigations settle at an
 *   unpredictable time — a fixed delay would race them. `pattern` is a
 *   `RegExp` built with `UrlMatch.make({ segments, end })`. `timeout`
 *   bounds the wait: if no matching `PageLoaded` is seen within it, the
 *   run aborts via `SniffingComplete` rather than hanging (the sync
 *   runner's idle timeout is the ultimate backstop).
 */
interface UrlMatchAdvance {
  readonly _tag: 'UrlMatch'
  readonly pattern: RegExp
  readonly timeout: Duration.Duration
}

/**
 * The advance condition attached to a {@link Any} step. A union so more
 * trigger kinds (element-present, response-seen, …) can be added later
 * without touching the step variants; today the only non-default kind is
 * {@link UrlMatchAdvance}.
 */
type Advance = UrlMatchAdvance

/**
 * A scripted navigation step. `Open` carries the same `WebViewSource`
 * shape the host uses for the initial `firstPage` so a slice's
 * `linkSequence` can mix inline HTML bootstraps and absolute `https://`
 * URIs without an extra translation layer. The Tauri host
 * (`browser-sniffer-tauri-rust`) maps `Link.Open` to an `OpenLink`
 * web→host message and navigates the existing sniffer `WebviewWindow`
 * to the new source.
 *
 * `advanceWhen` (optional, shared by every variant) gates *when* the
 * step machine dispatches this step — see {@link Advance}. It is a
 * plan-only field: the handler strips it before forwarding the step to
 * the sniffer, so it never reaches the wire.
 */
interface Open {
  readonly _tag: 'Open'
  readonly source: WebViewSource.Any
  readonly advanceWhen?: Advance
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
  readonly advanceWhen?: Advance
}

/**
 * A synthetic form fill. Forwarded verbatim (minus `advanceWhen`) as a
 * `Fill` host→web message on `BrowserSnifferBridge`; the injected
 * sniffer resolves `document.querySelector(querySelector)` and sets its
 * `value` through the framework-aware native value-setter +
 * `input`/`change` dispatch (so SPA frameworks like Angular pick up the
 * change). Best-effort like `Click` — a missing element silently
 * no-ops.
 *
 * `value` is provided by the plan, interpolated from the remote's config
 * (e.g. a username / password) when the collector builds its
 * `ScrapingPlan`. Because a credential can therefore ride this payload,
 * see the secrets note on `browser-sniffer-core`'s `FillMessageBody`.
 */
interface Fill {
  readonly _tag: 'Fill'
  readonly querySelector: string
  readonly value: string
  readonly advanceWhen?: Advance
}

type Any = Open | Click | Fill

export type { Open, Click, Fill, Any, Advance, UrlMatchAdvance }
