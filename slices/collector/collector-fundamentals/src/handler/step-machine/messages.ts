import type { PageActionMessage, PageLoadedMessageBody } from 'browser-sniffer-core'

import type { OpenMessage, SniffingComplete as SniffingCompleteMessage } from '../../bridge.ts'

/**
 * Parts 1 & 3 of the step machine: the input messages that drive it and
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
 * The subset of the handler's outbound messages the step machine can ask
 * the host to send: the scripted `Open` / `PageAction` navigation steps
 * and the terminal `SniffingComplete`. (`CancelSnifferRequest` is the
 * response tracker's, not the step machine's.)
 */
type StepOutboundMessage =
  | typeof OpenMessage.Type
  | typeof PageActionMessage.Type
  | typeof SniffingCompleteMessage.Type

// ---------------------------------------------------------------------------
// Input messages
// ---------------------------------------------------------------------------

/**
 * Everything that can drive the machine forward. Three kinds:
 *
 * - `PageLoaded` — the sole *external* event, forwarded verbatim from the
 *   bridge (its shape is `browser-sniffer-core`'s `PageLoadedMessageBody`,
 *   reused rather than re-declared).
 * - `Clear` / `CancelAllInFlight` — the two *commands* the composed
 *   handler folds into `clear` / `cancelAllInFlight`; modelling them as
 *   input messages keeps the whole machine a single transition table.
 * - `SettleTimerFired` / `UrlMatchTimeoutFired` — the *internal* timer
 *   expiries. A forked daemon re-injects one of these (carrying the
 *   `generation` it was scheduled under) rather than committing a
 *   transition directly, so the transition stays the single source of
 *   truth. A fired timer whose `generation` no longer matches the current
 *   state is a stale re-arm and is dropped.
 */
type InputMessage =
  | typeof PageLoadedMessageBody.Type
  | { readonly _tag: 'Clear' }
  | { readonly _tag: 'CancelAllInFlight' }
  | { readonly _tag: 'SettleTimerFired'; readonly generation: number }
  | { readonly _tag: 'UrlMatchTimeoutFired'; readonly generation: number }

// ---------------------------------------------------------------------------
// Side-effect messages
// ---------------------------------------------------------------------------

/**
 * The effects a transition can request. The transition function is pure —
 * it never sends a bridge message, forks a timer, or logs — it only
 * *names* these, which the interpreter in `./make.ts` discharges through
 * the handlers in `./side-effect-handlers.ts`.
 *
 * - `DispatchLink` / `DispatchSniffingComplete` — send a scripted step (or
 *   the terminal `SniffingComplete`) to the sniffer, span-wrapped.
 * - `ScheduleSettleTimer` / `ScheduleUrlMatchTimeout` — fork a daemon that
 *   sleeps then re-injects the matching `*Fired` input under `generation`.
 * - `CancelTimer` — interrupt the daemon registered under `generation`
 *   (the no-wasted-sleep optimisation; the generation guard alone would
 *   already make a fired-but-stale timer inert).
 * - `WarnUrlMatchTimeout` / `WarnDroppedPageLoaded` — the two WARN logs.
 *
 * Durations ride as `…Ms` numbers so the messages stay plain structs; the
 * handlers re-inflate via `Duration.millis`.
 */
type SideEffectMessage =
  | { readonly _tag: 'DispatchLink'; readonly dispatchIndex: number }
  | { readonly _tag: 'DispatchSniffingComplete'; readonly dispatchIndex: number }
  | {
      readonly _tag: 'ScheduleSettleTimer'
      readonly dispatchIndex: number
      readonly generation: number
    }
  | {
      readonly _tag: 'ScheduleUrlMatchTimeout'
      readonly dispatchIndex: number
      readonly generation: number
      readonly timeoutMs: number
    }
  | { readonly _tag: 'CancelTimer'; readonly generation: number }
  | {
      readonly _tag: 'WarnUrlMatchTimeout'
      readonly dispatchIndex: number
      readonly timeoutMs: number
    }
  | { readonly _tag: 'WarnDroppedPageLoaded'; readonly url: string }

// Terse constructors so the transition table reads as data, not object literals.
const dispatchLink = (dispatchIndex: number): SideEffectMessage => ({
  _tag: 'DispatchLink',
  dispatchIndex,
})
const dispatchSniffingComplete = (dispatchIndex: number): SideEffectMessage => ({
  _tag: 'DispatchSniffingComplete',
  dispatchIndex,
})
const scheduleSettleTimer = (dispatchIndex: number, generation: number): SideEffectMessage => ({
  _tag: 'ScheduleSettleTimer',
  dispatchIndex,
  generation,
})
const scheduleUrlMatchTimeout = (
  dispatchIndex: number,
  generation: number,
  timeoutMs: number
): SideEffectMessage => ({ _tag: 'ScheduleUrlMatchTimeout', dispatchIndex, generation, timeoutMs })
const cancelTimer = (generation: number): SideEffectMessage => ({ _tag: 'CancelTimer', generation })
const warnUrlMatchTimeout = (dispatchIndex: number, timeoutMs: number): SideEffectMessage => ({
  _tag: 'WarnUrlMatchTimeout',
  dispatchIndex,
  timeoutMs,
})
const warnDroppedPageLoaded = (url: string): SideEffectMessage => ({
  _tag: 'WarnDroppedPageLoaded',
  url,
})

export type { InputMessage, SideEffectMessage, StepOutboundMessage }
export {
  cancelTimer,
  dispatchLink,
  dispatchSniffingComplete,
  scheduleSettleTimer,
  scheduleUrlMatchTimeout,
  warnDroppedPageLoaded,
  warnUrlMatchTimeout,
}
