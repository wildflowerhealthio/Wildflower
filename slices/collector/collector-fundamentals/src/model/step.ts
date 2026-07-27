import type { PageActionMessage } from 'browser-sniffer-core'
import type { Duration } from 'effect'

import type { OpenMessage } from '../bridge.ts'

/**
 * What a {@link NavigationStep} tells the sniffer to do, typed *against the
 * bridge message bodies themselves* so a step can never carry a field the wire
 * doesn't:
 *
 * - `Open` (the collector bridge's `OpenMessage`): host-navigation. Carries
 *   the same `WebViewSource` shape the host uses for the initial `firstPage`,
 *   so a slice's `stepSequence` can mix inline-HTML bootstraps and absolute
 *   `https://` URIs without a translation layer. It is its own tag because
 *   the Tauri host *decodes* it to navigate the sniffer `WebviewWindow`.
 * - `PageAction` (`browser-sniffer-core`'s `PageActionMessage`): an in-page
 *   interaction (`Click` / `Fill`, discriminated by the inner `kind`). New
 *   interaction kinds are added as `action` union variants, not new tags.
 *
 * `StepAction` is the only step field that is *forwarded* to the wire: the
 * automatic-navigation machine passes a {@link NavigationStep}'s `action`
 * through untouched. Every other message the machine emits — `SniffingComplete`,
 * `EnsureSnifferVisible`, `SetSnifferStatus` — it constructs itself, so no plan
 * data rides those. Typing this against the bridge bodies is therefore what
 * stops a *plan* from putting a field on the wire that the wire doesn't have; it
 * is not a claim that only `Navigation` steps reach the host (an
 * {@link EnsureWindowVisibleStep} does too, via a machine-built message).
 *
 * The three plan-only holds ({@link DelayStep}, {@link AwaitPageSettledStep},
 * {@link AwaitUserDismissStep}) carry no `action` at all and are consumed by the
 * FSM as timers / holds, so they structurally cannot leak — there is no "strip
 * before dispatch" step to remember.
 */
type StepAction = typeof OpenMessage.Type | typeof PageActionMessage.Type

/**
 * A scripted navigation step: a {@link StepAction} the automatic-navigation
 * machine dispatches to the sniffer.
 *
 * A `Navigation` **always dispatches and immediately advances** to the next
 * queue entry — it never waits for a `PageLoaded`. An `Open` navigates the page
 * and a `Click` may too, but neither the machine nor the wire distinguishes
 * "this action loads a page" from "this one doesn't": a plan that must wait for
 * a load inserts an explicit {@link AwaitPageSettledStep} (or {@link DelayStep})
 * after the action. This keeps every action uniform — *fire and advance* — with
 * all waiting expressed as its own step.
 *
 * A `Fill` action's `value` is interpolated from the remote's config (e.g. a
 * username / password) when the collector builds its `ScrapingPlan`; because a
 * credential can therefore ride that payload, see the secrets note on
 * `browser-sniffer-core`'s `FillAction`. `name` is a manual, human-readable
 * label — see the shared `name` note on {@link Step}.
 */
interface NavigationStep {
  readonly _tag: 'Navigation'
  readonly name: string
  readonly action: StepAction
}

/**
 * A plan-only pause: the automatic-navigation machine arms a timer for
 * `duration`, waits it out, then processes the next queue entry. It is never
 * forwarded to the wire (it carries no `action`) — the FSM consumes it as a
 * timer, so a `Delay` structurally cannot reach the bridge.
 *
 * Use a `Delay` for a *fixed* wait whose length is known up front — most
 * commonly a *trailing* `Delay` so post-load XHR fan-out has time to start (and
 * be tracked) before the queue drains and the run completes. When the wait is
 * "until a page has loaded and gone quiet" rather than a fixed span, prefer
 * {@link AwaitPageSettledStep}.
 */
interface DelayStep {
  readonly _tag: 'Delay'
  readonly name: string
  readonly duration: Duration.Duration
}

/**
 * A plan-only hold that waits for a *settled page load* whose url matches
 * `pattern`, then processes the next queue entry. Like {@link DelayStep} it
 * carries no `action` and never reaches the wire — the FSM consumes it as a
 * hold.
 *
 * "Settled" is exactly the sniffer's `PageLoaded` signal, which fires **once
 * per page** only after that page has (a) fired `load` and (b) gone quiet — no
 * structural DOM mutation and no in-flight request for the sniffer's quiet
 * window — or hit the sniffer's internal max-wait ceiling. So this step waits
 * for a real, quiesced page rather than a raw `load`, which is what makes it the
 * right tool for a login redirect / SPA route whose settle time is
 * unpredictable (a fixed `Delay` would race it).
 *
 * `pattern` disambiguates *which* settled page to wait for (e.g. the post-login
 * `app.` host, not the login page). If the page already in hand when the hold is
 * reached already matches, it is satisfied immediately; otherwise the machine
 * parks until a matching `PageLoaded` arrives.
 *
 * `timeout` is the machine-side cap on that wait — distinct from the sniffer's
 * internal settle ceiling: if no matching settled `PageLoaded` arrives within
 * it, the run aborts via `SniffingComplete` rather than hanging (the sync
 * runner's idle timeout is the ultimate backstop). `pattern` is a `RegExp` built
 * with `UrlMatch.make({ segments, end })`.
 */
interface AwaitPageSettledStep {
  readonly _tag: 'AwaitPageSettled'
  readonly name: string
  readonly pattern: RegExp
  readonly timeout: Duration.Duration
}

/**
 * A plan-only hold that parks until the user dismisses the sniffer webview
 * (closes its window), then resumes draining the queue. Like {@link DelayStep} /
 * {@link AwaitPageSettledStep} it carries no `action` and never reaches the wire
 * — the FSM consumes it as a hold.
 *
 * What resumes it is an *external* signal rather than a page event: the Tauri
 * host detects the user-dismiss gesture (on desktop, the window's X → the
 * native-webview plugin's `Hidden` lifecycle event; the webview stays alive) and
 * emits a `UserDismissed` host→web message on the `CollectorBridge`. The
 * automatic-navigation machine takes it as its `UserDismissed` input and, only
 * while parked on this hold, consumes the hold and drains on. A `UserDismissed`
 * arriving in any other state is ignored.
 *
 * **Dismissing does not itself end the run.** Requests sniffed before the
 * dismissal may still be in flight, and the webview stays alive and keeps
 * sniffing them, so the hold resolves to the ordinary `Drained` state and the
 * run completes through the usual gate — queue drained **and** every sniffed
 * request settled. Ending the run directly on dismissal would strand those
 * requests: `SniffingComplete` would fire while the map was non-empty and the
 * results stream would never close.
 *
 * `timeout` bounds the wait, mirroring {@link AwaitPageSettledStep}'s: if the
 * user never closes the window, the hold gives up after it (WARN-logged) and
 * wraps up the same way rather than parking forever. Two more things can end the
 * wait early: the sniffer webview being torn down (the plugin's `Disposed`
 * event, surfaced as `SnifferDisposed`), and the sync runner's own idle guard —
 * so a plan ending in this step should set {@link ScrapingPlan.idleTimeout}
 * comfortably *above* this `timeout`, or the guard will abandon the run first.
 * Note also that the native-webview plugin's own absolute lifetime cap is not
 * re-armed by a `show`, so it can cut a very long hold short.
 *
 * Use this as the *terminal* step of a plan whose completion is the user's to
 * decide — e.g. the user finishes something manually in the browser and closing
 * the window is the "I'm done" signal.
 */
interface AwaitUserDismissStep {
  readonly _tag: 'AwaitUserDismiss'
  readonly name: string
  readonly timeout: Duration.Duration
}

/**
 * A fire-and-advance step that asks the host to (re-)present the sniffer webview
 * — the SPA sends an `EnsureSnifferVisible` message which the Tauri host turns
 * into a `native_webview().show(...)`. Like a {@link NavigationStep} it **reaches
 * the wire** and immediately advances (it carries no page action; the show is the
 * host's job), unlike the plan-only holds which the FSM consumes without
 * dispatching.
 *
 * `show` is idempotent and non-destructive: it re-presents a hidden-but-alive
 * webview without re-navigating, and no-ops if there is no webview. Its purpose is
 * to put the window on screen before a step that hands control to the user — most
 * importantly the pairing `[EnsureWindowVisible, AwaitUserDismiss]`, so that a
 * webview the user dismissed earlier in the run (now alive but hidden) is brought
 * back for them to close. Without it, a prior dismissal would leave the
 * `AwaitUserDismiss` hold waiting on a window that isn't visible.
 *
 * It is **best-effort, not a guarantee**, because it is fire-and-advance: nothing
 * is acknowledged, so the machine advances whether or not a window appeared. Two
 * consequences worth knowing when a plan pairs it with a hold:
 *
 * - If no live webview exists, the host's `show` lands harmlessly and the hold
 *   that follows waits on a window that never appears. What ends that wait is the
 *   hold's own `timeout` (and a `SnifferDisposed` if the webview is torn down),
 *   not anything this step detects — the plugin's `show` cannot distinguish
 *   "absent" from "already visible", so the host has no failure to report.
 * - A `Hidden` the plugin emitted *before* this show is indistinguishable from a
 *   real dismissal after it, so a stale one can end the following hold early.
 *   Acceptable because ending early now resumes draining rather than abandoning
 *   in-flight requests, but it is why the pairing is a strong convention rather
 *   than an enforced invariant.
 */
interface EnsureWindowVisibleStep {
  readonly _tag: 'EnsureWindowVisible'
  readonly name: string
}

/**
 * One entry in a {@link ScrapingPlan.stepSequence} (or generated by an
 * {@link EntityDefinition.followUpSteps}): a {@link NavigationStep} or an
 * {@link EnsureWindowVisibleStep} the automatic-navigation machine dispatches to
 * the host, or one of the plan-only holds the FSM consumes without dispatching —
 * a {@link DelayStep} (fixed wait), an {@link AwaitPageSettledStep} (wait for a
 * matching settled page load), or an {@link AwaitUserDismissStep} (wait for the
 * user to close the sniffer webview). A tagged union keyed by `_tag`; the
 * automatic-navigation machine routes on it.
 *
 * Every variant carries a **required** `name`: a manually-authored,
 * human-readable label ("Entering email", "Waiting for prescriptions to load")
 * the automatic-navigation machine pushes to the built-in sniffer browser's
 * native chrome (its subtitle) when the step begins, so a run is legible while
 * it executes. Unlike a `Navigation`'s `action`, `name` never rides the step's
 * own wire message — the machine surfaces it through a separate
 * `SetSnifferStatus` bridge control message (see `bridge.ts`), which is why the
 * plan-only holds (`Delay` / `AwaitPageSettled` / `AwaitUserDismiss`) can label
 * the chrome even though they carry no `action`. Because consecutive
 * `Navigation` steps drain in one turn, only the last of a back-to-back run is
 * visible — a name is most meaningful on a step that holds, or on one
 * immediately followed by a hold.
 */
type Step =
  | NavigationStep
  | DelayStep
  | AwaitPageSettledStep
  | AwaitUserDismissStep
  | EnsureWindowVisibleStep

export type {
  Step,
  NavigationStep,
  DelayStep,
  AwaitPageSettledStep,
  AwaitUserDismissStep,
  EnsureWindowVisibleStep,
  StepAction,
}
