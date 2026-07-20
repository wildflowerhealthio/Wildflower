import { Duration, Match } from 'effect'

import type { Step } from '../../model/step.ts'
import {
  cancelTimer,
  dispatchNavigation,
  dispatchSniffingComplete,
  type InputMessage,
  requestCompletionCheck,
  scheduleDelayTimer,
  scheduleUrlMatchTimeout,
  type SideEffectMessage,
  warnDroppedPageLoaded,
  warnDroppedSteps,
  warnUrlMatchTimeout,
} from './messages.ts'
import * as State from './state.ts'

/**
 * Part 5 of the automatic-navigation machine: the pure transition table.
 *
 * `transition(initialQueue)(state, message) → [state, effects]` — no `Effect`,
 * no fibers, no clock. It routes on the input `_tag`, then each arm routes on
 * the state `_tag`, and names the {@link SideEffectMessage}s the runtime should
 * discharge. The queue lives in the *state* (grown breadth-first by
 * `followUpSteps`), so the transition needs no `ScrapingPlan`; `initialQueue` is
 * closed over only to restore the queue on `Stop`. `g'` = the next generation;
 * arming a fresh timer always bumps it so a superseded timer's `*Fired` is
 * dropped as stale.
 *
 * Transition table (see [Handler Explanation](../../../docs/Handler%20Explanation.md)):
 *   AwaitingPageLoaded(q) ─PageLoaded→ processHead(q, url)
 *   DelayPending(q)       ─PageLoaded→ DelayPending(q)                 (no re-arm)
 *   DelayPending(q)       ─DelayTimerFired (gen match)→ processHead(q, ⊥)
 *   AwaitingUrlMatch(q)   ─PageLoaded, head UrlMatch matches→ dispatch head, AwaitingPageLoaded(tail)
 *   AwaitingUrlMatch(q)   ─PageLoaded, still unmatched→ AwaitingUrlMatch(q)   (no-op)
 *   AwaitingUrlMatch(q)   ─UrlMatchTimeoutFired (gen match)→ Done       (dispatches SniffingComplete)
 *   Drained               ─StepsGenerated→ processHead(steps, ⊥)        (re-awaken, no PageLoaded)
 *   Drained               ─NoMoreResultsExpected→ Done                  (dispatches SniffingComplete)
 *   <active>              ─StepsGenerated→ append to queue              (otherwise unchanged)
 *   <not Drained>         ─NoMoreResultsExpected→ no-op
 *   Done                  ─PageLoaded / StepsGenerated→ WARN-drop
 *   any                   ─Stop→ AwaitingPageLoaded(initialQueue)       (interrupt any pending timer)
 *
 * where `processHead(q, url)`:
 *   q empty            → Drained + RequestCompletionCheck (ask the lifecycle to confirm completion)
 *   Delay head         → arm timer, DelayPending(tail)
 *   Navigation, gate unmet (or no url) → AwaitingUrlMatch(q) + timeout   (head kept for dispatch)
 *   Navigation, ungated / gate met     → dispatch action, AwaitingPageLoaded(tail)
 */

/** A pure transition result: the next state and the effects it requests. */
type Transition = readonly [State.StepState, readonly SideEffectMessage[]]

/**
 * Pop and act on the queue head. `url` is the `PageLoaded` url in hand, or
 * `undefined` when the head is processed off a timer fire or a `Drained`
 * re-awaken — a `UrlMatch` gate can only be satisfied with a url, so a gated
 * head with no url in hand parks in `AwaitingUrlMatch` to await a matching
 * `PageLoaded`.
 */
const processHead = (
  queue: State.Queue,
  url: string | undefined,
  generation: number
): Transition => {
  const [head, ...tail] = queue
  if (head === undefined) {
    // Queue drained. Not terminal on its own — an in-flight request could still
    // generate more steps — so ask the lifecycle to confirm all requests have
    // settled (it re-injects `NoMoreResultsExpected` iff so).
    return [State.drained(generation), [requestCompletionCheck]]
  }
  if (head._tag === 'Delay') {
    const g = generation + 1
    return [State.delayPending(tail, g), [scheduleDelayTimer(g, Duration.toMillis(head.duration))]]
  }
  const advance = head.advanceWhen
  if (advance !== undefined && !(url !== undefined && advance.pattern.test(url))) {
    // Gated `Navigation` whose `UrlMatch` is not (yet) satisfied by this url:
    // keep it at the queue head and park under a fresh URL-match timeout.
    const g = generation + 1
    return [
      State.awaitingUrlMatch(queue, g),
      [scheduleUrlMatchTimeout(g, Duration.toMillis(advance.timeout))],
    ]
  }
  // Ungated, or gated and satisfied → dispatch the action now. No timer is
  // armed, so the generation is unchanged.
  return [State.awaitingPageLoaded(tail, generation), [dispatchNavigation(head.action)]]
}

const onPageLoaded = (state: State.StepState, url: string): Transition =>
  Match.value(state).pipe(
    Match.withReturnType<Transition>(),
    Match.tag('AwaitingPageLoaded', (s) => processHead(s.queue, url, s.generation)),
    // Extra `PageLoaded`s during a `Delay` do not re-arm the timer — explicit
    // delays make timing the plan author's responsibility.
    Match.tag('DelayPending', (s) => [s, []]),
    // Re-test the head step's pattern against this url. On a match, cancel the
    // timeout, dispatch the head, and advance; otherwise stay parked.
    Match.tag('AwaitingUrlMatch', (s) => {
      const [head, ...tail] = s.queue
      if (
        head !== undefined &&
        head._tag === 'Navigation' &&
        head.advanceWhen !== undefined &&
        head.advanceWhen.pattern.test(url)
      ) {
        return [
          State.awaitingPageLoaded(tail, s.generation),
          [cancelTimer(s.generation), dispatchNavigation(head.action)],
        ]
      }
      return [s, []]
    }),
    Match.tag('Drained', (s) => [s, [warnDroppedPageLoaded(url)]]),
    Match.tag('Done', (s) => [s, [warnDroppedPageLoaded(url)]]),
    Match.exhaustive
  )

const onDelayTimerFired = (state: State.StepState, generation: number): Transition => {
  // Stale fire — re-armed, cleared, or cancelled since it was scheduled.
  if (state._tag !== 'DelayPending' || state.generation !== generation) {
    return [state, []]
  }
  return processHead(state.queue, undefined, state.generation)
}

const onUrlMatchTimeoutFired = (state: State.StepState, generation: number): Transition => {
  if (state._tag !== 'AwaitingUrlMatch' || state.generation !== generation) {
    return [state, []] // stale fire — a match arrived first, or it was cleared
  }
  const head = state.queue[0]
  const timeoutMs =
    head !== undefined && head._tag === 'Navigation' && head.advanceWhen !== undefined
      ? Duration.toMillis(head.advanceWhen.timeout)
      : 0
  return [State.done(state.generation), [warnUrlMatchTimeout(timeoutMs), dispatchSniffingComplete]]
}

const onStepsGenerated = (state: State.StepState, steps: readonly Step[]): Transition => {
  if (steps.length === 0) {
    return [state, []]
  }
  const prependToExistingSteps = (queue: State.Queue): State.Queue => [...queue, ...steps]
  return Match.value(state).pipe(
    Match.withReturnType<Transition>(),
    // Idle: the generated head dispatches now (the machine is idle; the steps'
    // own `advanceWhen` gates still apply), typically re-entering
    // `AwaitingPageLoaded` on a navigation.
    Match.tag('Drained', (s) => processHead(steps, undefined, s.generation)),
    Match.tag('AwaitingPageLoaded', (s) => [
      State.awaitingPageLoaded(prependToExistingSteps(s.queue), s.generation),
      [],
    ]),
    Match.tag('DelayPending', (s) => [
      State.delayPending(prependToExistingSteps(s.queue), s.generation),
      [],
    ]),
    Match.tag('AwaitingUrlMatch', (s) => [
      State.awaitingUrlMatch(prependToExistingSteps(s.queue), s.generation),
      [],
    ]),
    // Terminal: a straggler request settled and generated steps after the run
    // completed. Nothing to do — drop and WARN.
    Match.tag('Done', (s) => [s, [warnDroppedSteps(steps.length)]]),
    Match.exhaustive
  )
}

const onNoMoreResultsExpected = (state: State.StepState): Transition =>
  state._tag === 'Drained'
    ? [State.done(state.generation), [dispatchSniffingComplete]]
    : [state, []]

// Halt the machine: interrupt any pending timer and restore the initial queue.
// The restored queue is not load-bearing — teardown discards the machine right
// after — so there is no "reset vs fold" distinction to preserve.
const onStop = (state: State.StepState, initialQueue: State.Queue): Transition =>
  Match.value(state).pipe(
    Match.withReturnType<Transition>(),
    Match.tag('DelayPending', (s) => [
      State.awaitingPageLoaded(initialQueue, s.generation),
      [cancelTimer(s.generation)],
    ]),
    Match.tag('AwaitingUrlMatch', (s) => [
      State.awaitingPageLoaded(initialQueue, s.generation),
      [cancelTimer(s.generation)],
    ]),
    Match.orElse((s) => [State.awaitingPageLoaded(initialQueue, s.generation), []])
  )

/**
 * The single transition table: `[state, input] → [state, effects]`, pure.
 * Routes on the input `_tag`, then each arm routes on the state `_tag`.
 * `initialQueue` is closed over only for `Stop`'s reset.
 */
const transition =
  (initialQueue: State.Queue) =>
  (state: State.StepState, message: InputMessage): Transition =>
    Match.value(message).pipe(
      Match.withReturnType<Transition>(),
      Match.tag('PageLoaded', (m) => onPageLoaded(state, m.url)),
      Match.tag('DelayTimerFired', (m) => onDelayTimerFired(state, m.generation)),
      Match.tag('UrlMatchTimeoutFired', (m) => onUrlMatchTimeoutFired(state, m.generation)),
      Match.tag('StepsGenerated', (m) => onStepsGenerated(state, m.steps)),
      Match.tag('NoMoreResultsExpected', () => onNoMoreResultsExpected(state)),
      Match.tag('Stop', () => onStop(state, initialQueue)),
      Match.exhaustive
    )

export type { Transition }
export { transition }
