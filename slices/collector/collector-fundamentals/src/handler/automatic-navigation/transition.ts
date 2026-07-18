import { Duration, Match } from 'effect'

import type { ScrapingPlan } from '../../model/index.ts'
import { type Advance, type DiscoveredMatch, isForEach } from '../../model/step.ts'
import {
  cancelTimer,
  dispatchQueryMatches,
  dispatchStep,
  dispatchSniffingComplete,
  type InputMessage,
  scheduleQueryMatchesTimeout,
  scheduleSettleTimer,
  scheduleUrlMatchTimeout,
  type SideEffectMessage,
  warnDroppedMatchesFound,
  warnDroppedPageLoaded,
  warnEmptyMatches,
  warnQueryMatchesTimeout,
  warnUrlMatchTimeout,
} from './messages.ts'
import {
  awaitingMatches,
  awaitingPageLoaded,
  awaitingUrlMatch,
  done,
  type QueueStep,
  stateOf,
  type StepPhase,
  type StepState,
  timerPending,
} from './state.ts'

/**
 * Part 5 of the automatic-navigation machine: the pure transition table.
 *
 * `transition(plan)(state, message) → [state, effects]` — no `Effect`, no
 * fibers, no clock. It routes on the input `_tag`, then each arm routes on
 * the phase `_tag`, and names the {@link SideEffectMessage}s the runtime
 * should discharge. `g'` = the next generation; scheduling a fresh timer
 * always bumps it so a superseded timer's `*Fired` is dropped as stale.
 *
 * The state carries the **dynamic step queue** alongside the phase (see
 * [state.ts](./state.ts)). Advance lookups and the terminal-length check read
 * that queue; a `ForEach` expansion rewrites it. The frozen `plan` is only
 * consulted to seed the reset queue on `Stop`.
 *
 * Transition table (queue carried forward unless noted):
 *   AwaitingPageLoaded(n)  ─PageLoaded, step n has no/ satisfied UrlMatch→ TimerPending(n, g')
 *   AwaitingPageLoaded(n)  ─PageLoaded, step n UrlMatch unmet→ AwaitingUrlMatch(n, g')
 *   AwaitingUrlMatch(d)    ─PageLoaded, url matches→ TimerPending(d, g')   (old timeout cancelled)
 *   AwaitingUrlMatch(d)    ─PageLoaded, url still unmatched→ AwaitingUrlMatch(d)  (no-op)
 *   AwaitingUrlMatch(d)    ─UrlMatchTimeoutFired (gen match)→ Done   (dispatches SniffingComplete)
 *   TimerPending(d)        ─PageLoaded→ TimerPending(d, g')   (old timer cancelled; fresh)
 *   TimerPending(d)        ─SettleTimerFired (gen match)→ dispatchAt(queue, d)   (leaf / ForEach / Done)
 *   AwaitingMatches(d)     ─MatchesFound (queryId match)→ TimerPending(d, g')   (queue expanded in place)
 *   AwaitingMatches(d)     ─MatchesFound (queryId mismatch)→ AwaitingMatches(d)  (WARN, drop)
 *   AwaitingMatches(d)     ─QueryMatchesTimeoutFired (gen match)→ Done   (dispatches SniffingComplete)
 *   AwaitingMatches(d)     ─PageLoaded→ AwaitingMatches(d)  (no-op; discovery didn't navigate)
 *   Done                   ─PageLoaded / MatchesFound→ Done (WARN-log)
 *   any                    ─Stop→ AwaitingPageLoaded(0), queue reset to plan (interrupt any pending timer)
 */

/** A pure transition result: the next state and the effects it requests. */
type Transition = readonly [StepState, readonly SideEffectMessage[]]

/**
 * The `advanceWhen` condition of the queue step at `index`, or `undefined` for
 * the out-of-range "index" that stands for the terminal `SniffingComplete`
 * (never gated) and for steps that don't declare one.
 */
const advanceAt = (queue: readonly QueueStep[], index: number): Advance | undefined =>
  index < queue.length ? queue[index].advanceWhen : undefined

/**
 * Arm the machine to act on the queue step at `index`, given `generation`:
 *
 * - out of range → terminal: `Done` + `SniffingComplete`.
 * - a `ForEachStep` → run discovery: send `QueryMatches` (carrying a `queryId`
 *   derived from the bumped generation so the answer correlates) and park in
 *   `AwaitingMatches` under a fresh discovery timeout.
 * - a `LeafStep` → dispatch its resolved `action` and await the next
 *   `PageLoaded` to arm `index + 1`.
 *
 * Shared by `onSettleTimerFired` (the step's settle elapsed) and `onMatchesFound`
 * (its settle re-armed after expansion), so both leaf dispatch and the terminal
 * check route through one place; a `ForEach` whose expansion left another step at
 * `index` is handled uniformly.
 */
const dispatchAt = (
  queue: readonly QueueStep[],
  index: number,
  generation: number
): readonly [StepPhase, readonly SideEffectMessage[]] => {
  if (index >= queue.length) {
    return [done(generation), [dispatchSniffingComplete(index)]]
  }
  const step = queue[index]
  if (isForEach(step)) {
    const g = generation + 1
    return [
      awaitingMatches(index, g),
      [
        dispatchQueryMatches(index, step.discover.querySelector, String(g)),
        scheduleQueryMatchesTimeout(index, g, Duration.toMillis(step.discover.timeout)),
      ],
    ]
  }
  return [awaitingPageLoaded(index + 1, generation), [dispatchStep(index, step.action)]]
}

const onPageLoaded = (state: StepState, url: string): Transition => {
  const { queue, phase } = state
  return Match.value(phase).pipe(
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
      const g = s.generation + 1
      const advance = advanceAt(queue, dispatchIndex)
      const settle: Transition = [
        stateOf(queue, timerPending(dispatchIndex, g)),
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
                stateOf(queue, awaitingUrlMatch(dispatchIndex, g)),
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
        stateOf(queue, timerPending(s.dispatchIndex, g)),
        [cancelTimer(s.generation), scheduleSettleTimer(s.dispatchIndex, g)],
      ]
    }),
    // Re-test the step's pattern against this url. On a match, cancel the
    // timeout and start the settle timer; otherwise stay parked.
    Match.tag('AwaitingUrlMatch', (s) => {
      const advance = advanceAt(queue, s.dispatchIndex)
      if (advance !== undefined && advance._tag === 'UrlMatch' && advance.pattern.test(url)) {
        const g = s.generation + 1
        return [
          stateOf(queue, timerPending(s.dispatchIndex, g)),
          [cancelTimer(s.generation), scheduleSettleTimer(s.dispatchIndex, g)],
        ]
      }
      return [state, []]
    }),
    // Discovery is in flight; the `QueryMatches` did not navigate, so a
    // `PageLoaded` here is unexpected — stay parked (the discovery timeout is
    // the backstop). Its answer arrives as `MatchesFound`, not a page load.
    Match.tag('AwaitingMatches', () => [state, []]),
    Match.tag('Done', () => [state, [warnDroppedPageLoaded(url)]]),
    Match.exhaustive
  )
}

const onSettleTimerFired = (state: StepState, generation: number): Transition => {
  const { queue, phase } = state
  // Stale fire — re-armed, cleared, or cancelled since it was scheduled
  // (each bumps the generation or leaves `TimerPending`).
  if (phase._tag !== 'TimerPending' || phase.generation !== generation) {
    return [state, []]
  }
  const [nextPhase, effects] = dispatchAt(queue, phase.dispatchIndex, phase.generation)
  return [stateOf(queue, nextPhase), effects]
}

const onUrlMatchTimeoutFired = (state: StepState, generation: number): Transition => {
  const { queue, phase } = state
  if (phase._tag !== 'AwaitingUrlMatch' || phase.generation !== generation) {
    return [state, []] // stale fire — a match arrived first, or it was cleared
  }
  const advance = advanceAt(queue, phase.dispatchIndex)
  const timeoutMs =
    advance !== undefined && advance._tag === 'UrlMatch' ? Duration.toMillis(advance.timeout) : 0
  return [
    stateOf(queue, done(phase.generation)),
    [
      warnUrlMatchTimeout(phase.dispatchIndex, timeoutMs),
      dispatchSniffingComplete(phase.dispatchIndex),
    ],
  ]
}

/**
 * The sniffer answered a `ForEach` step's discovery query. Only act when this
 * is the answer we are waiting for (`AwaitingMatches` at the matching
 * `generation`, which is the `queryId`); a mismatch is a stale/duplicate answer
 * and is dropped (WARN). On a match: cancel the discovery timeout, expand the
 * `ForEach` in place into `matches.length` body sub-sequences (empty → the
 * `ForEach` is simply removed — a clean skip, WARN-logged), and re-arm the
 * settle timer at the (now first body / next) step so it dispatches through the
 * same `dispatchAt` path — no new `PageLoaded` is coming, so the machine drives
 * itself forward.
 */
const onMatchesFound = (
  state: StepState,
  message: { readonly queryId: string; readonly matches: readonly DiscoveredMatch[] }
): Transition => {
  const { queue, phase } = state
  if (phase._tag !== 'AwaitingMatches' || String(phase.generation) !== message.queryId) {
    return [state, [warnDroppedMatchesFound(message.queryId)]]
  }
  const index = phase.dispatchIndex
  const forEachStep = queue[index]
  if (forEachStep === undefined || !isForEach(forEachStep)) {
    // Unreachable: `AwaitingMatches(index)` is only entered for a `ForEach` at
    // `index`, and the queue is only rewritten out of this phase. Fail safe by
    // dropping rather than throwing inside the pure transition.
    return [state, [warnDroppedMatchesFound(message.queryId)]]
  }
  const bodySteps = message.matches.flatMap((match) => forEachStep.body(match))
  const nextQueue: readonly QueueStep[] = [
    ...queue.slice(0, index),
    ...bodySteps,
    ...queue.slice(index + 1),
  ]
  const g = phase.generation + 1
  const effects: SideEffectMessage[] = [cancelTimer(phase.generation)]
  if (message.matches.length === 0) {
    effects.push(warnEmptyMatches(index, forEachStep.discover.querySelector))
  }
  effects.push(scheduleSettleTimer(index, g))
  return [stateOf(nextQueue, timerPending(index, g)), effects]
}

const onQueryMatchesTimeoutFired = (state: StepState, generation: number): Transition => {
  const { queue, phase } = state
  if (phase._tag !== 'AwaitingMatches' || phase.generation !== generation) {
    return [state, []] // stale fire — the answer arrived first, or it was cleared
  }
  const forEachStep = queue[phase.dispatchIndex]
  const querySelector =
    forEachStep !== undefined && isForEach(forEachStep) ? forEachStep.discover.querySelector : ''
  const timeoutMs =
    forEachStep !== undefined && isForEach(forEachStep)
      ? Duration.toMillis(forEachStep.discover.timeout)
      : 0
  return [
    stateOf(queue, done(phase.generation)),
    [
      warnQueryMatchesTimeout(phase.dispatchIndex, querySelector, timeoutMs),
      dispatchSniffingComplete(phase.dispatchIndex),
    ],
  ]
}

// Halt the machine: interrupt any pending timer, reset the queue to the frozen
// plan, and reset to index 0. The index/queue are not load-bearing — `teardown`
// discards the machine right after — so there is no "reset vs fold" distinction
// to preserve.
const onStop = <TResources>(
  scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>,
  state: StepState
): Transition => {
  const reset = stateOf(scrapingPlan.stepSequence, awaitingPageLoaded(0, state.phase.generation))
  // Interrupt any pending timer daemon — only the timer-bearing phases have one.
  const hasPendingTimer =
    state.phase._tag === 'TimerPending' ||
    state.phase._tag === 'AwaitingUrlMatch' ||
    state.phase._tag === 'AwaitingMatches'
  return [reset, hasPendingTimer ? [cancelTimer(state.phase.generation)] : []]
}

/**
 * The single transition table: `[state, input] → [state, effects]`, pure.
 * Routes on the input `_tag`, then each arm routes on the phase `_tag`.
 */
const transition =
  <TResources>(scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>) =>
  (state: StepState, message: InputMessage): Transition =>
    Match.value(message).pipe(
      Match.withReturnType<Transition>(),
      Match.tag('PageLoaded', (m) => onPageLoaded(state, m.url)),
      Match.tag('MatchesFound', (m) => onMatchesFound(state, m)),
      Match.tag('SettleTimerFired', (m) => onSettleTimerFired(state, m.generation)),
      Match.tag('UrlMatchTimeoutFired', (m) => onUrlMatchTimeoutFired(state, m.generation)),
      Match.tag('QueryMatchesTimeoutFired', (m) => onQueryMatchesTimeoutFired(state, m.generation)),
      Match.tag('Stop', () => onStop(scrapingPlan, state)),
      Match.exhaustive
    )

export type { Transition }
export { transition }
