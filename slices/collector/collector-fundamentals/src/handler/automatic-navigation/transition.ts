import { Duration, Match } from 'effect'

import type { Step } from '../../model/step.ts'
import {
  cancelTimer,
  dispatchEnsureVisible,
  dispatchNavigation,
  dispatchSniffingComplete,
  type InputMessage,
  requestCompletionCheck,
  scheduleDelayTimer,
  scheduleUrlMatchTimeout,
  scheduleUserDismissTimeout,
  setStepName,
  type SideEffectMessage,
  warnDroppedPageLoaded,
  warnDroppedSteps,
  warnSnifferDisposed,
  warnUrlMatchTimeout,
  warnUserDismissTimeout,
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
 * a `PageLoaded` on its own account. Waiting is expressed only by the three hold
 * steps: `Delay` (a fixed timer), `AwaitPageSettled` (park until a matching
 * settled `PageLoaded`), and `AwaitUserDismiss` (park until the user closes the
 * sniffer webview). `AwaitingPageLoaded` is therefore a *start-up-only* resting
 * state: the machine waits there for the first settled page load, then drains
 * the queue.
 *
 * Note the asymmetry in how the two *timed-out* holds end: an `AwaitPageSettled`
 * that times out **aborts** the run, because the page it needed never arrived
 * and every step after it is meaningless. An `AwaitUserDismiss` that ends — by
 * dismissal, timeout, or dispose — merely **resumes draining**, because the plan
 * got as far as handing control to the user and whatever was sniffed is a valid
 * result. Only that second path can leave requests in flight, which is why it
 * must go through `Drained` rather than completing directly.
 *
 * Transition table (see [Handler Explanation](../../../docs/Handler%20Explanation.md)):
 *   AwaitingPageLoaded(q) ─PageLoaded→ drain(q, url)                    (start-up: first settled load)
 *   DelayPending(q)       ─PageLoaded→ DelayPending(q)                  (no re-arm)
 *   DelayPending(q)       ─DelayTimerFired (gen match)→ drain(q, ⊥)
 *   AwaitingUrlMatch(q)   ─PageLoaded, head AwaitPageSettled matches→ drain(tail, url)  (cancels timeout)
 *   AwaitingUrlMatch(q)   ─PageLoaded, still unmatched→ AwaitingUrlMatch(q)   (no-op)
 *   AwaitingUrlMatch(q)   ─UrlMatchTimeoutFired (gen match)→ Done       (dispatches SniffingComplete)
 *   AwaitingUserDismiss(q)─UserDismissed→ drain(tail, ⊥)                (cancels timeout)
 *   AwaitingUserDismiss(q)─UserDismissTimeoutFired (gen match)→ drain(tail, ⊥)  (WARN)
 *   AwaitingUserDismiss(q)─SnifferDisposed→ drain(tail, ⊥)              (WARN; cancels timeout)
 *   AwaitingUserDismiss(q)─PageLoaded→ AwaitingUserDismiss(q)           (no-op; the webview is still alive)
 *   Drained               ─StepsGenerated→ drain(steps, ⊥)             (re-awaken, no PageLoaded)
 *   Drained               ─NoMoreResultsExpected→ Done                  (dispatches SniffingComplete)
 *   <active>              ─StepsGenerated→ append to queue              (otherwise unchanged)
 *   <not Drained>         ─NoMoreResultsExpected→ no-op
 *   <not parked>          ─UserDismissed / SnifferDisposed→ no-op       (silent: both also occur at teardown)
 *   Done                  ─PageLoaded / StepsGenerated→ WARN-drop
 *   any                   ─Stop→ AwaitingPageLoaded(initialQueue)       (interrupt any pending timer)
 *
 * where `drain(q, url)` pops entries front-to-back, dispatching each
 * `Navigation` and continuing, until it rests:
 *   q empty                             → Drained + RequestCompletionCheck (ask the lifecycle to confirm completion)
 *   Delay head                          → arm timer, DelayPending(tail)
 *   AwaitPageSettled head, url matches  → continue with tail             (already on the awaited page)
 *   AwaitPageSettled head, no/no-match  → AwaitingUrlMatch(q) + timeout  (head kept, parks for a matching PageLoaded)
 *   AwaitUserDismiss head               → AwaitingUserDismiss(q) + timeout (head kept, parks for UserDismissed)
 *   EnsureWindowVisible head            → dispatch EnsureSnifferVisible, continue with tail (fire-and-advance)
 *   Navigation head                     → dispatch action, continue with tail
 */

/** A pure transition result: the next state and the effects it requests. */
type Transition = readonly [State.StepState, readonly SideEffectMessage[]]

/**
 * Drain the queue front-to-back until it rests. `Navigation` and
 * `EnsureWindowVisible` heads **dispatch and continue** in the same turn; the
 * three holds rest instead — a `Delay` as a timer, an `AwaitPageSettled` parked
 * for a matching settled page, an `AwaitUserDismiss` parked for the user to
 * close the sniffer webview (each under a fresh generation, so a superseded
 * timer's `*Fired` is dropped as stale).
 *
 * `url` is the settled-page url in hand — the one that started this drain (a
 * `PageLoaded`), or `undefined` when draining off a timer fire, a `Drained`
 * re-awaken, or a consumed `AwaitUserDismiss` hold. An `AwaitPageSettled` is
 * satisfied immediately only if that url already matches its `pattern`;
 * otherwise it parks in `AwaitingUrlMatch` to await a matching settled
 * `PageLoaded`.
 *
 * Every step reached emits a leading `SetStepName` for its required `name`, so
 * the sniffer chrome's subtitle tracks the current step.
 */
const drainFrom = (queue: State.Queue, url: string | undefined, generation: number): Transition => {
  const [head, ...tail] = queue
  if (head === undefined) {
    // Queue drained. Not terminal on its own — an in-flight request could still
    // generate more steps — so ask the lifecycle to confirm all requests have
    // settled (it re-injects `NoMoreResultsExpected` iff so).
    return [State.drained(generation), [requestCompletionCheck]]
  }
  // Every step carries a required, human-readable `name`; surface it to the
  // sniffer chrome as the step begins. Prepended so the label paints before the
  // step's own effect (dispatch / timer / park) and before the tail drains — a
  // back-to-back `Navigation` run therefore leaves only the last name visible.
  const nameEffect = setStepName(head.name)
  if (head._tag === 'Delay') {
    const g = generation + 1
    return [
      State.delayPending(tail, g),
      [nameEffect, scheduleDelayTimer(g, Duration.toMillis(head.duration))],
    ]
  }
  if (head._tag === 'AwaitPageSettled') {
    if (url !== undefined && head.pattern.test(url)) {
      // Already on the settled page this hold waits for — proceed without parking.
      const [next, effects] = drainFrom(tail, url, generation)
      return [next, [nameEffect, ...effects]]
    }
    // The awaited page is not (yet) in hand: keep the hold at the queue head and
    // park under a fresh URL-match timeout until a matching `PageLoaded` arrives.
    const g = generation + 1
    return [
      State.awaitingUrlMatch(queue, g),
      [nameEffect, scheduleUrlMatchTimeout(g, Duration.toMillis(head.timeout))],
    ]
  }
  if (head._tag === 'AwaitUserDismiss') {
    // Keep the hold at the queue head and park under a fresh timeout. The wait
    // is driven by the external `UserDismissed` input (or `SnifferDisposed`),
    // but it is bounded like every other hold: a user who never closes the
    // window must not park the run forever.
    const g = generation + 1
    return [
      State.awaitingUserDismiss(queue, g),
      [nameEffect, scheduleUserDismissTimeout(g, Duration.toMillis(head.timeout))],
    ]
  }
  if (head._tag === 'EnsureWindowVisible') {
    // Fire-and-advance, like a Navigation: ask the host to re-present the sniffer
    // webview and keep draining the tail in the same turn. It is not a hold — it
    // dispatches and moves on — so no timer is armed (generation unchanged).
    const [next, effects] = drainFrom(tail, url, generation)
    return [next, [nameEffect, dispatchEnsureVisible, ...effects]]
  }
  // Navigation: dispatch the action now and keep draining the tail in the same
  // turn. A `Fill` / `Click` / `Open` never waits for a `PageLoaded` — waiting is
  // a hold step's job — so several actions can dispatch back-to-back. No timer is
  // armed, so the generation is unchanged.
  const [next, effects] = drainFrom(tail, url, generation)
  return [next, [nameEffect, dispatchNavigation(head.action), ...effects]]
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
    // Parked on an `AwaitUserDismiss` hold: the sniffer webview is still alive,
    // so a page it loads while the user has it open does not advance the queue —
    // only the external `UserDismissed` signal does.
    Match.tag('AwaitingUserDismiss', (s) => [s, []]),
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
    Match.tag('AwaitingUserDismiss', (s) => [
      State.awaitingUserDismiss(prependToExistingSteps(s.queue), s.generation),
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

/**
 * Consume a satisfied `AwaitUserDismiss` hold and resume draining its tail.
 * Shared by the three inputs that can end the wait — the user's dismissal, the
 * hold's own timeout, and the webview being disposed — because what happens
 * *after* the wait is identical in all three.
 *
 * Crucially this does **not** go straight to `Done` + `SniffingComplete`.
 * Requests sniffed before the wait may still be in flight, and the webview stays
 * alive and keeps sniffing them; completing here would fire `SniffingComplete`
 * with a non-empty incomplete-request map, and the lifecycle's
 * `handleSniffingComplete` only *closes* the stream when that map is empty — so
 * the results stream would never close and the run would hang until the idle
 * timeout. Draining to `Drained` instead hands completion back to the normal
 * gate: queue drained ∧ every request settled.
 *
 * A tail is possible (an entity's `followUpSteps` can append behind the hold
 * while it is parked), so the tail is drained rather than assumed empty.
 */
const resumeFromUserDismissHold = (
  state: Extract<State.StepState, { readonly _tag: 'AwaitingUserDismiss' }>,
  precedingEffects: readonly SideEffectMessage[]
): Transition => {
  const [, ...tail] = state.queue
  const [next, effects] = drainFrom(tail, undefined, state.generation)
  return [next, [...precedingEffects, ...effects]]
}

// The user dismissed (closed) the sniffer webview. Only meaningful while parked
// on an `AwaitUserDismiss` hold, where it consumes the hold (cancelling its
// timeout) and drains on. A silent no-op in every other state (a hide adjacent
// to teardown, or a run without the step, must not disturb it); unlike a stray
// `PageLoaded` this is expected, so it does not WARN.
const onUserDismissed = (state: State.StepState): Transition =>
  state._tag === 'AwaitingUserDismiss'
    ? resumeFromUserDismissHold(state, [cancelTimer(state.generation)])
    : [state, []]

// The hold's own timeout elapsed: the user never closed the window. Wrap up the
// same way a dismissal would, but WARN — the plan expected a user action that
// never came, and the run's results are whatever was sniffed up to here.
const onUserDismissTimeoutFired = (state: State.StepState, generation: number): Transition => {
  if (state._tag !== 'AwaitingUserDismiss' || state.generation !== generation) {
    return [state, []] // stale fire — the hold was already consumed or cleared
  }
  const head = state.queue[0]
  const timeoutMs =
    head !== undefined && head._tag === 'AwaitUserDismiss' ? Duration.toMillis(head.timeout) : 0
  return resumeFromUserDismissHold(state, [warnUserDismissTimeout(timeoutMs)])
}

// The sniffer webview was torn down. Only acted on while parked: the window the
// hold is waiting on no longer exists, so waiting out the remaining timeout
// would be pointless. Everywhere else it is a silent no-op — a dispose is also
// what this run's own `SniffingComplete` teardown produces, so one arrives on
// every run and must not be mistaken for a signal.
const onSnifferDisposed = (state: State.StepState): Transition =>
  state._tag === 'AwaitingUserDismiss'
    ? resumeFromUserDismissHold(state, [cancelTimer(state.generation), warnSnifferDisposed])
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
      Match.tag('UserDismissTimeoutFired', (m) => onUserDismissTimeoutFired(state, m.generation)),
      Match.tag('StepsGenerated', (m) => onStepsGenerated(state, m.steps)),
      Match.tag('NoMoreResultsExpected', () => onNoMoreResultsExpected(state)),
      Match.tag('UserDismissed', () => onUserDismissed(state)),
      Match.tag('SnifferDisposed', () => onSnifferDisposed(state)),
      Match.tag('Stop', () => onStop(state, initialQueue)),
      Match.exhaustive
    )

export type { Transition }
export { transition }
