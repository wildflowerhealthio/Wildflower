import type { PageActionMessage, PageLoadedMessageBody } from 'browser-sniffer-core'

import type {
  EnsureSnifferVisible as EnsureSnifferVisibleMessage,
  OpenMessage,
  SetSnifferStatus as SetSnifferStatusMessage,
  SniffingComplete as SniffingCompleteMessage,
} from '../../bridge.ts'
import type { Step, StepAction } from '../../model/step.ts'

/**
 * Parts 1 & 3 of the automatic-navigation machine: the input messages that drive it and
 * the side-effect messages a transition can request. Both are plain
 * discriminated unions keyed by `_tag`; the transition routes on `_tag`
 * via `Match.tag`. They are never decoded, encoded, or `Schema.is`-tested
 * — the machine is internal and its messages are constructed as literals
 * (or the terse side-effect constructors below) — so they are ordinary
 * types, not runtime `Schema`s. The one message that *does* cross a wire,
 * `PageLoaded`, reuses `browser-sniffer-core`'s `PageLoadedMessageBody`
 * schema type rather than re-declaring its shape.
 */

/**
 * The subset of the handler's outbound messages the automatic-navigation machine can ask
 * the host to send: the scripted `Open` / `PageAction` navigation steps,
 * the `EnsureSnifferVisible` show request, the terminal `SniffingComplete`, and
 * the `SetSnifferStatus` chrome-label update it emits as each step begins.
 * (`CancelSnifferRequest` is the response tracker's, not the
 * automatic-navigation machine's.)
 */
type StepOutboundMessage =
  | typeof OpenMessage.Type
  | typeof PageActionMessage.Type
  | typeof EnsureSnifferVisibleMessage.Type
  | typeof SniffingCompleteMessage.Type
  | typeof SetSnifferStatusMessage.Type

// ---------------------------------------------------------------------------
// Input messages
// ---------------------------------------------------------------------------

/**
 * Everything that can drive the machine forward — nine inputs, in seven kinds:
 *
 * - `PageLoaded` — the sole *external* event, forwarded verbatim from the
 *   bridge (its shape is `browser-sniffer-core`'s `PageLoadedMessageBody`,
 *   reused rather than re-declared).
 * - `Stop` — the single *command*, which the run lifecycle's teardown (and its
 *   idle-timeout abandon) invokes to halt the machine (interrupt any pending
 *   timer). Modelling it as an input keeps the whole machine one transition
 *   table. There is no separate "reset vs fold" variant: teardown always
 *   *discards* the machine (a fresh one is built next run).
 * - `DelayTimerFired` / `UrlMatchTimeoutFired` / `UserDismissTimeoutFired` — the
 *   *internal* timer expiries.
 *   A forked daemon re-injects one of these (carrying the `generation` it was
 *   scheduled under) rather than committing a transition directly, so the
 *   transition stays the single source of truth. A fired timer whose
 *   `generation` no longer matches the current state is a stale re-arm and is
 *   dropped.
 * - `StepsGenerated` — an entity's `followUpSteps` produced steps; the
 *   composition dedups/caps them and injects them here. From `Drained` it
 *   re-awakens the machine (process the new head, dispatching without waiting
 *   for a `PageLoaded`); from any active state it appends to the back of the
 *   queue and otherwise changes nothing.
 * - `NoMoreResultsExpected` — the lifecycle observed that no sniffed request is
 *   still incomplete. Only meaningful in `Drained` (`Drained → Done`,
 *   dispatching `SniffingComplete`); a no-op in every other state, because more
 *   `PageLoaded`s / generations may still come from steps not yet dispatched.
 * - `UserDismissed` — the *external* signal that the user closed (dismissed) the
 *   sniffer webview, forwarded from the host on the `CollectorBridge`. Only
 *   meaningful while parked on an `AwaitUserDismiss` hold, where it **consumes**
 *   the hold and resumes draining the queue tail; a silent no-op in every other
 *   state, since an incidental hide during a run without the step must not end
 *   it. It does *not* end the run directly — see `onUserDismissed` for why
 *   completion still has to go through `Drained`.
 * - `SnifferDisposed` — the *external* signal that the sniffer webview was torn
 *   down (the plugin's `Disposed` lifecycle event). Distinct from
 *   `UserDismissed`: a dispose is also what the run's own `SniffingComplete`
 *   teardown produces, so it arrives on *every* run — it is only acted on while
 *   parked, where the window the hold is waiting on no longer exists and the
 *   machine wraps up rather than waiting out the timeout.
 */
type InputMessage =
  | typeof PageLoadedMessageBody.Type
  | { readonly _tag: 'Stop' }
  | { readonly _tag: 'DelayTimerFired'; readonly generation: number }
  | { readonly _tag: 'UrlMatchTimeoutFired'; readonly generation: number }
  | { readonly _tag: 'UserDismissTimeoutFired'; readonly generation: number }
  | { readonly _tag: 'StepsGenerated'; readonly steps: readonly Step[] }
  | { readonly _tag: 'NoMoreResultsExpected' }
  | { readonly _tag: 'UserDismissed' }
  | { readonly _tag: 'SnifferDisposed' }

// ---------------------------------------------------------------------------
// Side-effect messages
// ---------------------------------------------------------------------------

/**
 * The effects a transition can request. The transition function is pure —
 * it never sends a bridge message, forks a timer, or logs — it only
 * *names* these, which the interpreter in `./make.ts` discharges through
 * the handlers in `./side-effect-handlers.ts`.
 *
 * - `SetStepName` — forward a step's manually-authored `name` to the host as a
 *   `SetSnifferStatus` bridge body, so the sniffer chrome's subtitle reflects
 *   the step that just began. Emitted by the transition for *every* step it
 *   reaches (a name is required on every step); the handler carries only the
 *   string, so it needs no plan lookup.
 * - `DispatchNavigation` — forward a `Navigation` step's `action` (already a
 *   bridge message body) to the sniffer, span-wrapped. The transition carries
 *   the action itself (the queue lives in the state), so the handler needs no
 *   plan lookup.
 * - `DispatchSniffingComplete` — send the terminal `SniffingComplete`, then run
 *   the `onSniffingComplete` hook, span-wrapped.
 * - `DispatchEnsureVisible` — send `EnsureSnifferVisible` (the fire-and-advance
 *   `EnsureWindowVisible` step's request to re-present the sniffer webview),
 *   span-wrapped.
 * - `ScheduleDelayTimer` / `ScheduleUrlMatchTimeout` /
 *   `ScheduleUserDismissTimeout` — fork a daemon that sleeps then re-injects the
 *   matching `*Fired` input under `generation`.
 * - `CancelTimer` — interrupt the daemon registered under `generation`
 *   (the no-wasted-sleep optimisation; the generation guard alone would
 *   already make a fired-but-stale timer inert).
 * - `RequestCompletionCheck` — emitted when the queue drains to `Drained`. The
 *   handler forks the injected `onDrained` effect (which asks the lifecycle
 *   whether requests have all settled and, if so, re-injects
 *   `NoMoreResultsExpected`). Forked, exactly like a timer, so it re-enters the
 *   machine's lock *after* this transition commits — no re-entrant deadlock.
 * - `WarnUrlMatchTimeout` / `WarnUserDismissTimeout` / `WarnSnifferDisposed` /
 *   `WarnDroppedPageLoaded` / `WarnDroppedSteps` — the WARN logs.
 *
 * Durations ride as `…Ms` numbers so the messages stay plain structs; the
 * handlers re-inflate via `Duration.millis`.
 */
type SideEffectMessage =
  | { readonly _tag: 'SetStepName'; readonly name: string }
  | { readonly _tag: 'DispatchNavigation'; readonly action: StepAction }
  | { readonly _tag: 'DispatchSniffingComplete' }
  | { readonly _tag: 'DispatchEnsureVisible' }
  | {
      readonly _tag: 'ScheduleDelayTimer'
      readonly generation: number
      readonly durationMs: number
    }
  | {
      readonly _tag: 'ScheduleUrlMatchTimeout'
      readonly generation: number
      readonly timeoutMs: number
    }
  | {
      readonly _tag: 'ScheduleUserDismissTimeout'
      readonly generation: number
      readonly timeoutMs: number
    }
  | { readonly _tag: 'CancelTimer'; readonly generation: number }
  | { readonly _tag: 'RequestCompletionCheck' }
  | { readonly _tag: 'WarnUrlMatchTimeout'; readonly timeoutMs: number }
  | { readonly _tag: 'WarnUserDismissTimeout'; readonly timeoutMs: number }
  | { readonly _tag: 'WarnSnifferDisposed' }
  | { readonly _tag: 'WarnDroppedPageLoaded'; readonly url: string }
  | { readonly _tag: 'WarnDroppedSteps'; readonly count: number }

// Terse constructors so the transition table reads as data, not object literals.
const setStepName = (name: string): SideEffectMessage => ({ _tag: 'SetStepName', name })
const dispatchNavigation = (action: StepAction): SideEffectMessage => ({
  _tag: 'DispatchNavigation',
  action,
})
const dispatchSniffingComplete: SideEffectMessage = { _tag: 'DispatchSniffingComplete' }
const dispatchEnsureVisible: SideEffectMessage = { _tag: 'DispatchEnsureVisible' }
const scheduleDelayTimer = (generation: number, durationMs: number): SideEffectMessage => ({
  _tag: 'ScheduleDelayTimer',
  generation,
  durationMs,
})
const scheduleUrlMatchTimeout = (generation: number, timeoutMs: number): SideEffectMessage => ({
  _tag: 'ScheduleUrlMatchTimeout',
  generation,
  timeoutMs,
})
const scheduleUserDismissTimeout = (generation: number, timeoutMs: number): SideEffectMessage => ({
  _tag: 'ScheduleUserDismissTimeout',
  generation,
  timeoutMs,
})
const cancelTimer = (generation: number): SideEffectMessage => ({ _tag: 'CancelTimer', generation })
const requestCompletionCheck: SideEffectMessage = { _tag: 'RequestCompletionCheck' }
const warnUrlMatchTimeout = (timeoutMs: number): SideEffectMessage => ({
  _tag: 'WarnUrlMatchTimeout',
  timeoutMs,
})
const warnUserDismissTimeout = (timeoutMs: number): SideEffectMessage => ({
  _tag: 'WarnUserDismissTimeout',
  timeoutMs,
})
const warnSnifferDisposed: SideEffectMessage = { _tag: 'WarnSnifferDisposed' }
const warnDroppedPageLoaded = (url: string): SideEffectMessage => ({
  _tag: 'WarnDroppedPageLoaded',
  url,
})
const warnDroppedSteps = (count: number): SideEffectMessage => ({
  _tag: 'WarnDroppedSteps',
  count,
})

export type { InputMessage, SideEffectMessage, StepOutboundMessage }
export {
  cancelTimer,
  dispatchEnsureVisible,
  dispatchNavigation,
  dispatchSniffingComplete,
  requestCompletionCheck,
  scheduleDelayTimer,
  scheduleUrlMatchTimeout,
  scheduleUserDismissTimeout,
  setStepName,
  warnDroppedPageLoaded,
  warnDroppedSteps,
  warnSnifferDisposed,
  warnUrlMatchTimeout,
  warnUserDismissTimeout,
}
