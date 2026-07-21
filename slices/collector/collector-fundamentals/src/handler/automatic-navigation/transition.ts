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
 * Every `Navigation` **dispatches and immediately advances** — no step waits for
 * a `PageLoaded` on its own account. Waiting is expressed only by the two hold
 * steps: `Delay` (a fixed timer) and `AwaitPageSettled` (park until a matching
 * settled `PageLoaded`). `AwaitingPageLoaded` is therefore a *start-up-only*
 * resting state: the machine waits there for the first settled page load, then
 * drains the queue.
 *
 * Transition table (see [Handler Explanation](../../../docs/Handler%20Explanation.md)):
 *   AwaitingPageLoaded(q) ─PageLoaded→ drain(q, url)                    (start-up: first settled load)
 *   DelayPending(q)       ─PageLoaded→ DelayPending(q)                  (no re-arm)
 *   DelayPending(q)       ─DelayTimerFired (gen match)→ drain(q, ⊥)
 *   AwaitingUrlMatch(q)   ─PageLoaded, head AwaitPageSettled matches→ drain(tail, url)  (cancels timeout)
 *   AwaitingUrlMatch(q)   ─PageLoaded, still unmatched→ AwaitingUrlMatch(q)   (no-op)
 *   AwaitingUrlMatch(q)   ─UrlMatchTimeoutFired (gen match)→ Done       (dispatches SniffingComplete)
 *   Drained               ─StepsGenerated→ drain(steps, ⊥)             (re-awaken, no PageLoaded)
 *   Drained               ─NoMoreResultsExpected→ Done                  (dispatches SniffingComplete)
 *   <active>              ─StepsGenerated→ append to queue              (otherwise unchanged)
 *   <not Drained>         ─NoMoreResultsExpected→ no-op
 *   Done                  ─PageLoaded / StepsGenerated→ WARN-drop
 *   any                   ─Stop→ AwaitingPageLoaded(initialQueue)       (interrupt any pending timer)
 *
 * where `drain(q, url)` pops entries front-to-back, dispatching each
 * `Navigation` and continuing, until it rests:
 *   q empty                             → Drained + RequestCompletionCheck (ask the lifecycle to confirm completion)
 *   Delay head                          → arm timer, DelayPending(tail)
 *   AwaitPageSettled head, url matches  → continue with tail             (already on the awaited page)
 *   AwaitPageSettled head, no/no-match  → AwaitingUrlMatch(q) + timeout  (head kept, parks for a matching PageLoaded)
 *   Navigation head                     → dispatch action, continue with tail
 */

/** A pure transition result: the next state and the effects it requests. */
type Transition = readonly [State.StepState, readonly SideEffectMessage[]]

/**
 * Drain the queue front-to-back: dispatch each `Navigation` and continue,
 * consume a `Delay` as a timer, and satisfy or park on an `AwaitPageSettled`.
 * `url` is the settled-page url in hand — the one that started this drain (a
 * `PageLoaded`), or `undefined` when draining off a timer fire or a `Drained`
 * re-awaken. An `AwaitPageSettled` is satisfied immediately only if that url
 * already matches its `pattern`; otherwise it parks in `AwaitingUrlMatch` to
 * await a matching settled `PageLoaded`.
 */
const drainFrom = (queue: State.Queue, url: string | undefined, generation: number): Transition => {
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
  if (head._tag === 'AwaitPageSettled') {
    if (url !== undefined && head.pattern.test(url)) {
      // Already on the settled page this hold waits for — proceed without parking.
      return drainFrom(tail, url, generation)
    }
    // The awaited page is not (yet) in hand: keep the hold at the queue head and
    // park under a fresh URL-match timeout until a matching `PageLoaded` arrives.
    const g = generation + 1
    return [
      State.awaitingUrlMatch(queue, g),
      [scheduleUrlMatchTimeout(g, Duration.toMillis(head.timeout))],
    ]
  }
  // Navigation: dispatch the action now and keep draining the tail in the same
  // turn. A `Fill` / `Click` / `Open` never waits for a `PageLoaded` — waiting is
  // a hold step's job — so several actions can dispatch back-to-back. No timer is
  // armed, so the generation is unchanged.
  const [next, effects] = drainFrom(tail, url, generation)
  return [next, [dispatchNavigation(head.action), ...effects]]
}

const onPageLoaded = (state: State.StepState, url: string): Transition =>
  Match.value(state).pipe(
    Match.withReturnType<Transition>(),
    // Start-up: the first settled page load kicks off draining the queue.
    Match.tag('AwaitingPageLoaded', (s) => drainFrom(s.queue, url, s.generation)),
    // Extra `PageLoaded`s during a `Delay` do not re-arm the timer — fixed
    // delays make timing the plan author's responsibility.
    Match.tag('DelayPending', (s) => [s, []]),
    // An `AwaitPageSettled` hold: if this settled page matches, cancel the
    // timeout and resume draining from the tail (the hold is consumed, never
    // dispatched); otherwise stay parked.
    Match.tag('AwaitingUrlMatch', (s) => {
      const [head, ...tail] = s.queue
      if (head !== undefined && head._tag === 'AwaitPageSettled' && head.pattern.test(url)) {
        const [next, effects] = drainFrom(tail, url, s.generation)
        return [next, [cancelTimer(s.generation), ...effects]]
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
  return drainFrom(state.queue, undefined, state.generation)
}

const onUrlMatchTimeoutFired = (state: State.StepState, generation: number): Transition => {
  if (state._tag !== 'AwaitingUrlMatch' || state.generation !== generation) {
    return [state, []] // stale fire — a match arrived first, or it was cleared
  }
  const head = state.queue[0]
  const timeoutMs =
    head !== undefined && head._tag === 'AwaitPageSettled' ? Duration.toMillis(head.timeout) : 0
  return [State.done(state.generation), [warnUrlMatchTimeout(timeoutMs), dispatchSniffingComplete]]
}

const onStepsGenerated = (state: State.StepState, steps: readonly Step[]): Transition => {
  if (steps.length === 0) {
    return [state, []]
  }
  const prependToExistingSteps = (queue: State.Queue): State.Queue => [...queue, ...steps]
  return Match.value(state).pipe(
    Match.withReturnType<Transition>(),
    // Idle: the generated steps drain now (the machine is idle; a generated
    // `Navigation` dispatches immediately, a generated hold parks), typically
    // re-entering `Drained` once they finish.
    Match.tag('Drained', (s) => drainFrom(steps, undefined, s.generation)),
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
