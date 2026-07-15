import { Duration, Match } from 'effect'

import { ScrapingPlan } from '../../model/index.ts'
import {
  cancelTimer,
  dispatchStep,
  dispatchSniffingComplete,
  type InputMessage,
  scheduleSettleTimer,
  scheduleUrlMatchTimeout,
  type SideEffectMessage,
  warnDroppedPageLoaded,
  warnUrlMatchTimeout,
} from './messages.ts'
import {
  awaitingPageLoaded,
  awaitingUrlMatch,
  done,
  type StepState,
  timerPending,
} from './state.ts'

/**
 * Part 5 of the step machine: the pure transition table.
 *
 * `transition(plan)(state, message) → [state, effects]` — no `Effect`, no
 * fibers, no clock. It routes on the input `_tag`, then each arm routes on
 * the state `_tag`, and names the {@link SideEffectMessage}s the runtime
 * should discharge. `g'` = the next generation; scheduling a fresh timer
 * always bumps it so a superseded timer's `*Fired` is dropped as stale.
 *
 * Transition table:
 *   AwaitingPageLoaded(n)  ─PageLoaded, step n has no/ satisfied UrlMatch→ TimerPending(n, g')
 *   AwaitingPageLoaded(n)  ─PageLoaded, step n UrlMatch unmet→ AwaitingUrlMatch(n, g')
 *   AwaitingUrlMatch(d)    ─PageLoaded, url matches→ TimerPending(d, g')   (old timeout cancelled)
 *   AwaitingUrlMatch(d)    ─PageLoaded, url still unmatched→ AwaitingUrlMatch(d)  (no-op)
 *   AwaitingUrlMatch(d)    ─UrlMatchTimeoutFired (gen match)→ Done   (dispatches SniffingComplete)
 *   TimerPending(d)        ─PageLoaded→ TimerPending(d, g')   (old timer cancelled; fresh)
 *   TimerPending(d)        ─SettleTimerFired (gen match), `d < N` → AwaitingPageLoaded(d + 1)
 *   TimerPending(N)        ─SettleTimerFired (gen match), `d ≡ N` → Done
 *   Done                   ─PageLoaded→ Done (WARN-log)
 *   any                    ─Clear→ AwaitingPageLoaded(0)
 *   any                    ─CancelAllInFlight→ AwaitingPageLoaded(d) (d preserved)
 */

/** A pure transition result: the next state and the effects it requests. */
type Transition = readonly [StepState, readonly SideEffectMessage[]]

const onPageLoaded = <TResources>(
  scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>,
  state: StepState,
  url: string
): Transition =>
  Match.value(state).pipe(
    Match.withReturnType<Transition>(),
    Match.tag('AwaitingPageLoaded', (s) => {
      /*
       * Arm the machine for `dispatchIndex` given the url of the `PageLoaded`
       * just observed. A step with no `advanceWhen` (or a `UrlMatch` already
       * satisfied by this url) goes to the `stepDelay` settle timer; a `UrlMatch`
       * whose pattern does not match parks in `AwaitingUrlMatch` under a fresh
       * timeout. `generation` is the *current* generation; the fresh timer is
       * scheduled at `generation + 1`. The `advanceWhen` kind is dispatched
       * through `Match` so future `Advance` kinds become arms, not an `if` chain.
       */
      const dispatchIndex: number = s.nextIndex
      const generation: number = s.generation

      const g = generation + 1
      const advance = ScrapingPlan.advanceConditionByIndex(scrapingPlan, dispatchIndex)
      const settle: Transition = [
        timerPending(dispatchIndex, g),
        [scheduleSettleTimer(dispatchIndex, g)],
      ]
      if (advance === undefined) {
        return settle
      }
      return Match.value(advance).pipe(
        Match.withReturnType<Transition>(),
        Match.tag('UrlMatch', (urlMatch) =>
          urlMatch.pattern.test(url)
            ? settle
            : [
                awaitingUrlMatch(dispatchIndex, g),
                [scheduleUrlMatchTimeout(dispatchIndex, g, Duration.toMillis(urlMatch.timeout))],
              ]
        ),
        Match.exhaustive
      )
    }),
    // Page navigated again mid-wait: interrupt the settle timer and restart
    // it at the same index (the URL gate, if any, was already satisfied to
    // reach `TimerPending`).
    Match.tag('TimerPending', (s) => {
      const g = s.generation + 1
      return [
        timerPending(s.dispatchIndex, g),
        [cancelTimer(s.generation), scheduleSettleTimer(s.dispatchIndex, g)],
      ]
    }),
    // Re-test the step's pattern against this url. On a match, cancel the
    // timeout and start the settle timer; otherwise stay parked.
    Match.tag('AwaitingUrlMatch', (s) => {
      const advance = ScrapingPlan.advanceConditionByIndex(scrapingPlan, s.dispatchIndex)
      if (advance !== undefined && advance._tag === 'UrlMatch' && advance.pattern.test(url)) {
        const g = s.generation + 1
        return [
          timerPending(s.dispatchIndex, g),
          [cancelTimer(s.generation), scheduleSettleTimer(s.dispatchIndex, g)],
        ]
      }
      return [s, []]
    }),
    Match.tag('Done', (s) => [s, [warnDroppedPageLoaded(url)]]),
    Match.exhaustive
  )

const onSettleTimerFired = <TResources>(
  scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>,
  state: StepState,
  generation: number
): Transition => {
  // Stale fire — re-armed, cleared, or cancelled since it was scheduled
  // (each bumps the generation or leaves `TimerPending`).
  if (state._tag !== 'TimerPending' || state.generation !== generation) {
    return [state, []]
  }
  if (state.dispatchIndex < scrapingPlan.stepSequence.length) {
    return [
      awaitingPageLoaded(state.dispatchIndex + 1, state.generation),
      [dispatchStep(state.dispatchIndex)],
    ]
  }
  return [done(state.generation), [dispatchSniffingComplete(state.dispatchIndex)]]
}

const onUrlMatchTimeoutFired = <TResources>(
  scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>,
  state: StepState,
  generation: number
): Transition => {
  if (state._tag !== 'AwaitingUrlMatch' || state.generation !== generation) {
    return [state, []] // stale fire — a match arrived first, or it was cleared
  }
  const advance = ScrapingPlan.advanceConditionByIndex(scrapingPlan, state.dispatchIndex)
  const timeoutMs =
    advance !== undefined && advance._tag === 'UrlMatch' ? Duration.toMillis(advance.timeout) : 0
  return [
    done(state.generation),
    [
      warnUrlMatchTimeout(state.dispatchIndex, timeoutMs),
      dispatchSniffingComplete(state.dispatchIndex),
    ],
  ]
}

// Reset to index 0 regardless of prior state; interrupt any pending timer.
const onClear = (state: StepState): Transition =>
  Match.value(state).pipe(
    Match.withReturnType<Transition>(),
    Match.tag('TimerPending', (s) => [
      awaitingPageLoaded(0, s.generation),
      [cancelTimer(s.generation)],
    ]),
    Match.tag('AwaitingUrlMatch', (s) => [
      awaitingPageLoaded(0, s.generation),
      [cancelTimer(s.generation)],
    ]),
    Match.orElse((s) => [awaitingPageLoaded(0, s.generation), []])
  )

// Fold back to AwaitingPageLoaded at the *same* index so a future
// PageLoaded re-attempts the step; interrupt any pending timer.
const onCancelAllInFlight = (state: StepState): Transition =>
  Match.value(state).pipe(
    Match.withReturnType<Transition>(),
    Match.tag('TimerPending', (s) => [
      awaitingPageLoaded(s.dispatchIndex, s.generation),
      [cancelTimer(s.generation)],
    ]),
    Match.tag('AwaitingUrlMatch', (s) => [
      awaitingPageLoaded(s.dispatchIndex, s.generation),
      [cancelTimer(s.generation)],
    ]),
    Match.orElse((s) => [s, []])
  )

/**
 * The single transition table: `[state, input] → [state, effects]`, pure.
 * Routes on the input `_tag`, then each arm routes on the state `_tag`.
 */
const transition =
  <TResources>(scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>) =>
  (state: StepState, message: InputMessage): Transition =>
    Match.value(message).pipe(
      Match.withReturnType<Transition>(),
      Match.tag('PageLoaded', (m) => onPageLoaded(scrapingPlan, state, m.url)),
      Match.tag('SettleTimerFired', (m) => onSettleTimerFired(scrapingPlan, state, m.generation)),
      Match.tag('UrlMatchTimeoutFired', (m) =>
        onUrlMatchTimeoutFired(scrapingPlan, state, m.generation)
      ),
      Match.tag('Clear', () => onClear(state)),
      Match.tag('CancelAllInFlight', () => onCancelAllInFlight(state)),
      Match.exhaustive
    )

export type { Transition }
export { transition }
