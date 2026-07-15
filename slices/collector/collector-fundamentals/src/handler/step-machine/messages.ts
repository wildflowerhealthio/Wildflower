import { type PageActionMessage, PageLoadedMessageBody } from 'browser-sniffer-core'
import { Schema } from 'effect'

import type { OpenMessage, SniffingComplete as SniffingCompleteMessage } from '../../bridge.ts'

/**
 * Parts 1 & 3 of the step machine: the input messages that drive it and
 * the side-effect messages a transition can request. Both are objects
 * keyed by `_tag`, each value a runtime `Schema`; the transition routes on
 * `_tag` via `Match.tag`, but `Schema.is(InputMessages.Clear)` &c. are
 * available as predicates too.
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
 *   bridge (its schema is `browser-sniffer-core`'s `PageLoadedMessageBody`,
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
const InputMessages = {
  PageLoaded: PageLoadedMessageBody,
  Clear: Schema.TaggedStruct('Clear', {}),
  CancelAllInFlight: Schema.TaggedStruct('CancelAllInFlight', {}),
  SettleTimerFired: Schema.TaggedStruct('SettleTimerFired', { generation: Schema.Number }),
  UrlMatchTimeoutFired: Schema.TaggedStruct('UrlMatchTimeoutFired', { generation: Schema.Number }),
} as const

type InputMessage = Schema.Schema.Type<(typeof InputMessages)[keyof typeof InputMessages]>

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
const SideEffectMessages = {
  DispatchLink: Schema.TaggedStruct('DispatchLink', { dispatchIndex: Schema.Number }),
  DispatchSniffingComplete: Schema.TaggedStruct('DispatchSniffingComplete', {
    dispatchIndex: Schema.Number,
  }),
  ScheduleSettleTimer: Schema.TaggedStruct('ScheduleSettleTimer', {
    dispatchIndex: Schema.Number,
    generation: Schema.Number,
  }),
  ScheduleUrlMatchTimeout: Schema.TaggedStruct('ScheduleUrlMatchTimeout', {
    dispatchIndex: Schema.Number,
    generation: Schema.Number,
    timeoutMs: Schema.Number,
  }),
  CancelTimer: Schema.TaggedStruct('CancelTimer', { generation: Schema.Number }),
  WarnUrlMatchTimeout: Schema.TaggedStruct('WarnUrlMatchTimeout', {
    dispatchIndex: Schema.Number,
    timeoutMs: Schema.Number,
  }),
  WarnDroppedPageLoaded: Schema.TaggedStruct('WarnDroppedPageLoaded', { url: Schema.String }),
} as const

type SideEffectMessage = Schema.Schema.Type<
  (typeof SideEffectMessages)[keyof typeof SideEffectMessages]
>

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
  InputMessages,
  SideEffectMessages,
  cancelTimer,
  dispatchLink,
  dispatchSniffingComplete,
  scheduleSettleTimer,
  scheduleUrlMatchTimeout,
  warnDroppedPageLoaded,
  warnUrlMatchTimeout,
}
