import type {
  MatchesFoundMessageBody,
  PageActionMessage,
  PageLoadedMessageBody,
  QueryMatchesMessage,
} from 'browser-sniffer-core'

import type { OpenMessage, SniffingComplete as SniffingCompleteMessage } from '../../bridge.ts'
import type { StepAction } from '../../model/step.ts'

/**
 * Parts 1 & 3 of the automatic-navigation machine: the input messages that drive it and
 * the side-effect messages a transition can request. Both are plain
 * discriminated unions keyed by `_tag`; the transition routes on `_tag`
 * via `Match.tag`. They are never decoded, encoded, or `Schema.is`-tested
 * — the machine is internal and its messages are constructed as literals
 * (or the terse side-effect constructors below) — so they are ordinary
 * types, not runtime `Schema`s. The two messages that *do* cross a wire,
 * `PageLoaded` and `MatchesFound`, reuse `browser-sniffer-core`'s body
 * schema types rather than re-declaring their shape.
 */

/**
 * The subset of the handler's outbound messages the automatic-navigation machine can ask
 * the host to send: the scripted `Open` / `PageAction` navigation steps, the
 * `QueryMatches` discovery request, and the terminal `SniffingComplete`.
 * (`CancelSnifferRequest` is the response tracker's, not the automatic-navigation
 * machine's.)
 */
type StepOutboundMessage =
  | typeof OpenMessage.Type
  | typeof PageActionMessage.Type
  | typeof QueryMatchesMessage.Type
  | typeof SniffingCompleteMessage.Type

// ---------------------------------------------------------------------------
// Input messages
// ---------------------------------------------------------------------------

/**
 * Everything that can drive the machine forward. Three kinds:
 *
 * - `PageLoaded` / `MatchesFound` — the two *external* events, forwarded
 *   verbatim from the bridge (their shapes are `browser-sniffer-core`'s
 *   `PageLoadedMessageBody` / `MatchesFoundMessageBody`, reused rather than
 *   re-declared). `MatchesFound` answers a `ForEach` step's discovery query.
 * - `Stop` — the single *command*, which the run lifecycle's `teardown`
 *   invokes to halt the machine (interrupt any pending timer). Modelling it
 *   as an input keeps the whole machine one transition table. There is no
 *   separate "reset vs fold" variant: teardown always *discards* the machine
 *   (a fresh one is built next run), so post-stop state would never be
 *   observed.
 * - `SettleTimerFired` / `UrlMatchTimeoutFired` / `QueryMatchesTimeoutFired` —
 *   the *internal* timer expiries. A forked daemon re-injects one of these
 *   (carrying the `generation` it was scheduled under) rather than committing
 *   a transition directly, so the transition stays the single source of
 *   truth. A fired timer whose `generation` no longer matches the current
 *   state is a stale re-arm and is dropped.
 */
type InputMessage =
  | typeof PageLoadedMessageBody.Type
  | typeof MatchesFoundMessageBody.Type
  | { readonly _tag: 'Stop' }
  | { readonly _tag: 'SettleTimerFired'; readonly generation: number }
  | { readonly _tag: 'UrlMatchTimeoutFired'; readonly generation: number }
  | { readonly _tag: 'QueryMatchesTimeoutFired'; readonly generation: number }

// ---------------------------------------------------------------------------
// Side-effect messages
// ---------------------------------------------------------------------------

/**
 * The effects a transition can request. The transition function is pure —
 * it never sends a bridge message, forks a timer, or logs — it only
 * *names* these, which the interpreter in `./make.ts` discharges through
 * the handlers in `./side-effect-handlers.ts`.
 *
 * - `DispatchStep` / `DispatchSniffingComplete` — send a scripted step (or
 *   the terminal `SniffingComplete`) to the sniffer, span-wrapped. Because
 *   the queue lives *in the state* — and a side-effect handler sees the
 *   committed-*before* state — `DispatchStep` carries the resolved `action`
 *   rather than an index into a queue it can't see.
 * - `DispatchQueryMatches` — send a `ForEach` step's discovery request
 *   (`QueryMatches`) carrying the `queryId` the answer must echo.
 * - `ScheduleSettleTimer` / `ScheduleUrlMatchTimeout` /
 *   `ScheduleQueryMatchesTimeout` — fork a daemon that sleeps then re-injects
 *   the matching `*Fired` input under `generation`.
 * - `CancelTimer` — interrupt the daemon registered under `generation`
 *   (the no-wasted-sleep optimisation; the generation guard alone would
 *   already make a fired-but-stale timer inert).
 * - `WarnUrlMatchTimeout` / `WarnQueryMatchesTimeout` / `WarnEmptyMatches` /
 *   `WarnDroppedMatchesFound` / `WarnDroppedPageLoaded` — the WARN logs.
 *
 * Durations ride as `…Ms` numbers so the messages stay plain structs; the
 * handlers re-inflate via `Duration.millis`.
 */
type SideEffectMessage =
  | { readonly _tag: 'DispatchStep'; readonly dispatchIndex: number; readonly action: StepAction }
  | { readonly _tag: 'DispatchSniffingComplete'; readonly dispatchIndex: number }
  | {
      readonly _tag: 'DispatchQueryMatches'
      readonly dispatchIndex: number
      readonly querySelector: string
      readonly queryId: string
    }
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
  | {
      readonly _tag: 'ScheduleQueryMatchesTimeout'
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
  | {
      readonly _tag: 'WarnQueryMatchesTimeout'
      readonly dispatchIndex: number
      readonly querySelector: string
      readonly timeoutMs: number
    }
  | {
      readonly _tag: 'WarnEmptyMatches'
      readonly dispatchIndex: number
      readonly querySelector: string
    }
  | { readonly _tag: 'WarnDroppedMatchesFound'; readonly queryId: string }
  | { readonly _tag: 'WarnDroppedPageLoaded'; readonly url: string }

// Terse constructors so the transition table reads as data, not object literals.
const dispatchStep = (dispatchIndex: number, action: StepAction): SideEffectMessage => ({
  _tag: 'DispatchStep',
  dispatchIndex,
  action,
})
const dispatchSniffingComplete = (dispatchIndex: number): SideEffectMessage => ({
  _tag: 'DispatchSniffingComplete',
  dispatchIndex,
})
const dispatchQueryMatches = (
  dispatchIndex: number,
  querySelector: string,
  queryId: string
): SideEffectMessage => ({ _tag: 'DispatchQueryMatches', dispatchIndex, querySelector, queryId })
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
const scheduleQueryMatchesTimeout = (
  dispatchIndex: number,
  generation: number,
  timeoutMs: number
): SideEffectMessage => ({
  _tag: 'ScheduleQueryMatchesTimeout',
  dispatchIndex,
  generation,
  timeoutMs,
})
const cancelTimer = (generation: number): SideEffectMessage => ({ _tag: 'CancelTimer', generation })
const warnUrlMatchTimeout = (dispatchIndex: number, timeoutMs: number): SideEffectMessage => ({
  _tag: 'WarnUrlMatchTimeout',
  dispatchIndex,
  timeoutMs,
})
const warnQueryMatchesTimeout = (
  dispatchIndex: number,
  querySelector: string,
  timeoutMs: number
): SideEffectMessage => ({
  _tag: 'WarnQueryMatchesTimeout',
  dispatchIndex,
  querySelector,
  timeoutMs,
})
const warnEmptyMatches = (dispatchIndex: number, querySelector: string): SideEffectMessage => ({
  _tag: 'WarnEmptyMatches',
  dispatchIndex,
  querySelector,
})
const warnDroppedMatchesFound = (queryId: string): SideEffectMessage => ({
  _tag: 'WarnDroppedMatchesFound',
  queryId,
})
const warnDroppedPageLoaded = (url: string): SideEffectMessage => ({
  _tag: 'WarnDroppedPageLoaded',
  url,
})

export type { InputMessage, SideEffectMessage, StepOutboundMessage }
export {
  cancelTimer,
  dispatchQueryMatches,
  dispatchStep,
  dispatchSniffingComplete,
  scheduleQueryMatchesTimeout,
  scheduleSettleTimer,
  scheduleUrlMatchTimeout,
  warnDroppedMatchesFound,
  warnDroppedPageLoaded,
  warnEmptyMatches,
  warnQueryMatchesTimeout,
  warnUrlMatchTimeout,
}
