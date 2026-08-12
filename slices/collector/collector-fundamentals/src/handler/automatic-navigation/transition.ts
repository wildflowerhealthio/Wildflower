import { Duration, Match } from 'effect'

import type { Step } from '../../model/step.ts'
import {
  cancelTimer,
  dispatchEnsureVisible,
  dispatchNavigation,
  dispatchSniffingComplete,
  drainedGuardExpired,
  type InputMessage,
  requestCompletionCheck,
  scheduleDelayTimer,
  scheduleDrainedGuard,
  scheduleUrlMatchTimeout,
  scheduleUserDismissTimeout,
  setStepName,
  type SideEffectMessage,
  warnDrainedGuardExpired,
  warnDroppedPageLoaded,
  warnDroppedSteps,
  warnSnifferDisposed,
  warnUrlMatchAdvanced,
  warnUrlMatchTimeout,
  warnUserDismissTimeout,
} from './messages.ts'
import * as State from './state.ts'

/**
 * Part 5 of the automatic-navigation machine: the pure transition table.
 *
 * `transition(initialQueue, drainedGuardTimeoutMs)(state, message) → [state,
 * effects]` — no `Effect`, no fibers, no clock. It routes on the input `_tag`,
 * then each arm routes on the state `_tag`, and names the
 * {@link SideEffectMessage}s the runtime should discharge. The queue lives in
 * the *state* (grown breadth-first by `followUpSteps`), so the transition needs
 * no `ScrapingPlan`; `initialQueue` is closed over only to restore the queue on
 * `Stop`, and `drainedGuardTimeoutMs` only to arm the `Drained` guard. `g'` =
 * the next generation; arming a fresh timer always bumps it so a superseded
 * timer's `*Fired` is dropped as stale.
 *
 * Every `Navigation` **dispatches and immediately advances** — no step waits for
 * a `PageLoaded` on its own account. Waiting is expressed only by the four hold
 * steps: `Delay` (a fixed timer), `AwaitPageSettled` (park until a matching
 * settled `PageLoaded`), `AwaitPageRequested` (park until a matching page has
 * merely *arrived* — the early `PageRequested` fired at `DOMContentLoaded` — or
 * a matching settled `PageLoaded`, which implies arrival), and
 * `AwaitUserDismiss` (park until the user closes the sniffer webview).
 * `AwaitingPageLoaded` is therefore a *start-up-only* resting state, left by
 * whichever comes first of two triggers: the composition's one-shot `Start`
 * command (injected right after the sniffer mount) or the first settled
 * `PageLoaded`. Both drain the queue — the leading step is an `Open`, a
 * navigation that needs no page in hand — so `Start` is what stops a mount whose
 * first page never settles from stranding the run here (this state arms no
 * timer). A `PageRequested` never starts the start-up drain — a plan's first
 * steps may act on a DOM that is still loading.
 *
 * Note the asymmetry in how the two *timed-out* holds end: an `AwaitPageSettled`
 * (or `AwaitPageRequested`) that times out **aborts** the run by default, because
 * the page it needed never arrived and every step after it is meaningless —
 * unless the hold set `continueOnTimeout: true`, in which case the expiry instead
 * **resumes draining** (the page was best-effort, not a precondition). An
 * `AwaitUserDismiss` that ends — by dismissal, timeout, or dispose — always
 * **resumes draining**, because the plan got as far as handing control to the
 * user and whatever was sniffed is a valid result. Both drain paths can leave
 * requests in flight, which is why they go through `Drained` rather than
 * completing directly.
 *
 * Transition table (see [Handler Explanation](../../../docs/Handler%20Explanation.md)):
 * ```text
 *   AwaitingPageLoaded(q) ─Start→ drain(q, ⊥)                          (start-up kick: no page needed; races the first PageLoaded)
 *   AwaitingPageLoaded(q) ─PageLoaded→ drain(q, url)                    (start-up: first settled load)
 *   DelayPending(q)       ─PageLoaded→ DelayPending(q)                  (no re-arm)
 *   DelayPending(q)       ─DelayTimerFired (gen match)→ drain(q, ⊥)
 *   AwaitingUrlMatch(q)   ─PageLoaded, head hold matches→ drain(tail, url settled)  (either hold kind; cancels timeout)
 *   AwaitingUrlMatch(q)   ─PageRequested, head AwaitPageRequested matches→ drain(tail, url unsettled)  (cancels timeout)
 *   AwaitingUrlMatch(q)   ─PageLoaded/PageRequested, still unmatched→ AwaitingUrlMatch(q)  (no-op)
 *   AwaitingUrlMatch(q)   ─UrlMatchTimeoutFired (gen match)→ Done       ('Timed out' chrome label + SniffingComplete; unless continueOnTimeout:true → drain(tail, ⊥))
 *   AwaitingUserDismiss(q)─UserDismissed→ drain(tail, ⊥)                (cancels timeout)
 *   AwaitingUserDismiss(q)─UserDismissTimeoutFired (gen match)→ drain(tail, ⊥)  (WARN)
 *   AwaitingUserDismiss(q)─SnifferDisposed→ drain(tail, ⊥)              (WARN; cancels timeout)
 *   AwaitingUserDismiss(q)─PageLoaded→ AwaitingUserDismiss(q)           (no-op; the webview is still alive)
 *   Drained               ─StepsGenerated→ drain(steps, ⊥)             (re-awaken, no PageLoaded; cancels the guard)
 *   Drained               ─NoMoreResultsExpected→ Done                  ('Done' chrome label + SniffingComplete; cancels the guard)
 *   Drained               ─DrainedGuardTimeoutFired (gen match)→ Drained (WARN + DrainedGuardExpired → abandon)
 *   <active>              ─StepsGenerated→ append to queue              (otherwise unchanged)
 *   <not Drained>         ─NoMoreResultsExpected→ no-op
 *   <not parked>          ─UserDismissed / SnifferDisposed→ no-op       (silent: both also occur at teardown)
 *   <not AwaitingPageLoaded>─Start→ no-op                              (the start-up kick already happened)
 *   Done                  ─PageLoaded / StepsGenerated→ WARN-drop
 *   any                   ─Stop→ AwaitingPageLoaded(initialQueue)       (interrupt any pending timer)
 * ```
 *
 * where `drain(q, url)` pops entries front-to-back, dispatching each
 * `Navigation` and continuing, until it rests:
 * ```text
 *   q empty                             → Drained + RequestCompletionCheck + drained guard timer (g')
 *   Delay head                          → arm timer, DelayPending(tail)
 *   AwaitPageSettled head (with pattern), settled url matches → continue with tail  (already on the awaited page)
 *   AwaitPageSettled head (no pattern)  → always AwaitingUrlMatch(q) + timeout  (never matches in hand; waits for the next settle)
 *   AwaitPageRequested head, any url matches   → continue with tail      (arrival suffices; settled implies arrived)
 *   either page hold head, otherwise    → AwaitingUrlMatch(q) + timeout  (head kept, parks for a matching page event)
 *   AwaitUserDismiss head               → AwaitingUserDismiss(q) + timeout (head kept, parks for UserDismissed)
 *   EnsureWindowVisible head            → dispatch EnsureSnifferVisible, continue with tail (fire-and-advance)
 *   Navigation head                     → dispatch action, continue with tail
 * ```
 */

/** A pure transition result: the next state and the effects it requests. */
type Transition = readonly [State.StepState, readonly SideEffectMessage[]]

/**
 * The page event a drain was started by, if any: its url plus whether it was a
 * *settled* `PageLoaded` or only an early `PageRequested` arrival. A settled
 * page satisfies both hold kinds (a settled page necessarily arrived); a
 * merely-requested page satisfies only an `AwaitPageRequested` head — an
 * `AwaitPageSettled` reached in the same drain must still park.
 */
interface PageInHand {
  readonly url: string
  readonly settled: boolean
}

/**
 * Run `effects` before the ones a computed transition already requested, keeping
 * its next state. Used where a transition has to cancel a timer *before*
 * whatever the drain it delegates to arms next.
 */
const prependEffects = (
  effects: readonly SideEffectMessage[],
  [next, tailEffects]: Transition
): Transition => [next, [...effects, ...tailEffects]]

/**
 * Drain the queue front-to-back until it rests. `Navigation` and
 * `EnsureWindowVisible` heads **dispatch and continue** in the same turn; the
 * three holds rest instead — a `Delay` as a timer, an `AwaitPageSettled` parked
 * for a matching settled page, an `AwaitUserDismiss` parked for the user to
 * close the sniffer webview (each under a fresh generation, so a superseded
 * timer's `*Fired` is dropped as stale).
 *
 * `page` is the {@link PageInHand} that started this drain (a `PageLoaded` or
 * `PageRequested`), or `undefined` when draining off a timer fire, a `Drained`
 * re-awaken, or a consumed `AwaitUserDismiss` hold. An `AwaitPageSettled` is
 * satisfied immediately only if a *settled* page in hand matches its
 * `pattern`; an `AwaitPageRequested` by any matching page in hand. Otherwise
 * the hold parks in `AwaitingUrlMatch` to await a matching page event.
 *
 * Every step reached emits a leading `SetStepName` for its required `name`, so
 * the sniffer chrome's subtitle tracks the current step.
 */
const drainFrom = (
  queue: State.Queue,
  page: PageInHand | undefined,
  generation: number,
  drainedGuardTimeoutMs: number
): Transition => {
  const [head, ...tail] = queue
  if (head === undefined) {
    // Queue drained. Not terminal on its own — an in-flight request could still
    // generate more steps — so ask the lifecycle to confirm all requests have
    // settled (it re-injects `NoMoreResultsExpected` iff so).
    //
    // Also arm the drained guard — from here on no hold is parked, so it is the
    // only bound on a request that never terminates. Under a fresh generation
    // like every other timer, which is what makes it self-disarming. See the
    // Handler Explanation § the drained guard.
    const g = generation + 1
    return [
      State.drained(g),
      [requestCompletionCheck, scheduleDrainedGuard(g, drainedGuardTimeoutMs)],
    ]
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
  if (head._tag === 'AwaitPageSettled' || head._tag === 'AwaitPageRequested') {
    // A settled page in hand satisfies either hold kind; a merely-requested one
    // satisfies only `AwaitPageRequested`. A *pattern-less* `AwaitPageSettled`
    // is never satisfied by the page in hand (it waits for the *next* settle),
    // so it always parks — which is what makes it skip the `about:blank` mount
    // (and any earlier page) and hold for the page the preceding `Open` opened.
    const satisfied =
      page !== undefined &&
      (page.settled || head._tag === 'AwaitPageRequested') &&
      head.pattern !== undefined &&
      head.pattern.test(page.url)
    if (satisfied) {
      // Already on the page this hold waits for — proceed without parking.
      const [next, effects] = drainFrom(tail, page, generation, drainedGuardTimeoutMs)
      return [next, [nameEffect, ...effects]]
    }
    // The awaited page is not (yet) in hand: keep the hold at the queue head and
    // park under a fresh URL-match timeout until a matching page event arrives.
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
    const [next, effects] = drainFrom(tail, page, generation, drainedGuardTimeoutMs)
    return [next, [nameEffect, dispatchEnsureVisible, ...effects]]
  }
  // Navigation: dispatch the action now and keep draining the tail in the same
  // turn. A `Fill` / `Click` / `Open` never waits for a `PageLoaded` — waiting is
  // a hold step's job — so several actions can dispatch back-to-back. No timer is
  // armed, so the generation is unchanged.
  const [next, effects] = drainFrom(tail, page, generation, drainedGuardTimeoutMs)
  return [next, [nameEffect, dispatchNavigation(head.action), ...effects]]
}

// The runner's one-shot start-up kick, injected at run start. Drains the queue
// with no page in hand — the leading step is an `Open` (a navigation) that
// builds the sniffer webview directly on the real target URL, so start-up needs
// no settled page — which is what stops a sniffer whose first page never settles
// (its web content process dies, say) from stranding the run in the timer-less
// `AwaitingPageLoaded`. A no-op in every other state: it races the sniffer's own
// first `PageLoaded`, and whichever lands first drains (the drain leaves
// `AwaitingPageLoaded`, so the loser is inert here).
const onStart = (state: State.StepState, drainedGuardTimeoutMs: number): Transition =>
  state._tag === 'AwaitingPageLoaded'
    ? drainFrom(state.queue, undefined, state.generation, drainedGuardTimeoutMs)
    : [state, []]

const onPageLoaded = (
  state: State.StepState,
  url: string,
  drainedGuardTimeoutMs: number
): Transition =>
  Match.value(state).pipe(
    Match.withReturnType<Transition>(),
    // Start-up: the first settled page load kicks off draining the queue (unless
    // `Start` already did — then this state is left and the load lands below).
    Match.tag('AwaitingPageLoaded', (s) =>
      drainFrom(s.queue, { url, settled: true }, s.generation, drainedGuardTimeoutMs)
    ),
    // Extra `PageLoaded`s during a `Delay` do not re-arm the timer — fixed
    // delays make timing the plan author's responsibility.
    Match.tag('DelayPending', (s) => [s, []]),
    // A parked page hold: a settled page satisfies either hold kind, so if this
    // page matches, cancel the timeout and resume draining from the tail (the
    // hold is consumed, never dispatched); otherwise stay parked. A pattern-less
    // `AwaitPageSettled` head matches *any* settled load.
    Match.tag('AwaitingUrlMatch', (s) => {
      const [head, ...tail] = s.queue
      if (
        head !== undefined &&
        (head._tag === 'AwaitPageSettled' || head._tag === 'AwaitPageRequested') &&
        (head.pattern === undefined || head.pattern.test(url))
      ) {
        const [next, effects] = drainFrom(
          tail,
          { url, settled: true },
          s.generation,
          drainedGuardTimeoutMs
        )
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

// The early page-arrival sibling of `onPageLoaded`. Deliberately narrower:
// it satisfies only a parked `AwaitPageRequested` head — it must not start the
// start-up drain (a plan's first steps may act on a DOM that is still loading)
// and an `AwaitPageSettled` hold still requires real settlement. Everywhere
// else it is a silent no-op rather than a WARN: every document emits one right
// before its `PageLoaded`, so a dropped `PageRequested` carries no diagnostic
// signal the dropped `PageLoaded`'s WARN doesn't already.
const onPageRequested = (
  state: State.StepState,
  url: string,
  drainedGuardTimeoutMs: number
): Transition => {
  if (state._tag !== 'AwaitingUrlMatch') {
    return [state, []]
  }
  const [head, ...tail] = state.queue
  if (head !== undefined && head._tag === 'AwaitPageRequested' && head.pattern.test(url)) {
    const [next, effects] = drainFrom(
      tail,
      { url, settled: false },
      state.generation,
      drainedGuardTimeoutMs
    )
    return [next, [cancelTimer(state.generation), ...effects]]
  }
  return [state, []]
}

const onDelayTimerFired = (
  state: State.StepState,
  generation: number,
  drainedGuardTimeoutMs: number
): Transition => {
  // Stale fire — re-armed, cleared, or cancelled since it was scheduled.
  if (state._tag !== 'DelayPending' || state.generation !== generation) {
    return [state, []]
  }
  return drainFrom(state.queue, undefined, state.generation, drainedGuardTimeoutMs)
}

// Terminal chrome labels the machine writes to the sniffer subtitle (a
// `SetSnifferStatus`, reusing `setStepName`) right before it dispatches
// `SniffingComplete`, so a finished run no longer freezes the chrome on the last
// step's name. The host disposes the webview on `SniffingComplete`, so
// `DONE_STATUS` is short-lived (a clean finish tears the window down at once);
// `TIMED_OUT_STATUS` is the one a user actually reads, because an aborted run
// leaves the window on screen.
const DONE_STATUS = 'Done'
const TIMED_OUT_STATUS = 'Timed out'

const onUrlMatchTimeoutFired = (
  state: State.StepState,
  generation: number,
  drainedGuardTimeoutMs: number
): Transition => {
  if (state._tag !== 'AwaitingUrlMatch' || state.generation !== generation) {
    return [state, []] // stale fire — a match arrived first, or it was cleared
  }
  const head = state.queue[0]
  if (
    head !== undefined &&
    (head._tag === 'AwaitPageSettled' || head._tag === 'AwaitPageRequested')
  ) {
    const timeoutMs = Duration.toMillis(head.timeout)
    // `continueOnTimeout` turns the expiry into an *advance* rather than an
    // abort: consume the unmatched hold and drain its tail (no page in hand, so
    // a following hold parks) — the page was best-effort, not a precondition.
    if (head.continueOnTimeout === true) {
      const [, ...tail] = state.queue
      const [next, effects] = drainFrom(tail, undefined, state.generation, drainedGuardTimeoutMs)
      return [next, [warnUrlMatchAdvanced(timeoutMs), ...effects]]
    }
    return [
      State.done(state.generation),
      [setStepName(TIMED_OUT_STATUS), warnUrlMatchTimeout(timeoutMs), dispatchSniffingComplete],
    ]
  }
  // Not a page hold at the head (shouldn't happen in `AwaitingUrlMatch`) — keep
  // the abort default rather than silently advancing.
  return [
    State.done(state.generation),
    [setStepName(TIMED_OUT_STATUS), warnUrlMatchTimeout(0), dispatchSniffingComplete],
  ]
}

const onStepsGenerated = (
  state: State.StepState,
  steps: readonly Step[],
  drainedGuardTimeoutMs: number
): Transition => {
  if (steps.length === 0) {
    return [state, []]
  }
  const prependToExistingSteps = (queue: State.Queue): State.Queue => [...queue, ...steps]
  return Match.value(state).pipe(
    Match.withReturnType<Transition>(),
    // Idle: the generated steps drain now (the machine is idle; a generated
    // `Navigation` dispatches immediately, a generated hold parks), typically
    // re-entering `Drained` once they finish.
    Match.tag('Drained', (s) =>
      // Re-awakening: drop the guard armed on entry to this `Drained`. The
      // generation bump already makes its fire inert, so this is the
      // no-wasted-sleep half.
      prependEffects(
        [cancelTimer(s.generation)],
        drainFrom(steps, undefined, s.generation, drainedGuardTimeoutMs)
      )
    ),
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
    ? [
        State.done(state.generation),
        // The run completed cleanly; the guard's pending sleep is dead weight.
        [cancelTimer(state.generation), setStepName(DONE_STATUS), dispatchSniffingComplete],
      ]
    : [state, []]

/**
 * The drained guard elapsed — a sniffed request never reached a terminal event.
 * See [Handler Explanation](../../../docs/Handler%20Explanation.md#the-drained-guard-the-only-bound-on-gate-b),
 * including why the machine can infer that without reading the request map.
 *
 * Stays `Drained` rather than advancing to `Done`: `DrainedGuardExpired` hands
 * off to `abandonAllRequestSniffing`, which force-closes the stream. Dispatching
 * `SniffingComplete` here instead would close it against a non-empty map and
 * hang the run — the very failure this guard exists to prevent.
 */
const onDrainedGuardTimeoutFired = (
  state: State.StepState,
  generation: number,
  drainedGuardTimeoutMs: number
): Transition => {
  if (state._tag !== 'Drained' || state.generation !== generation) {
    // Stale fire — the queue re-awakened, the run completed, or it was cleared.
    return [state, []]
  }
  return [state, [warnDrainedGuardExpired(drainedGuardTimeoutMs), drainedGuardExpired]]
}

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
  precedingEffects: readonly SideEffectMessage[],
  drainedGuardTimeoutMs: number
): Transition => {
  const [, ...tail] = state.queue
  const [next, effects] = drainFrom(tail, undefined, state.generation, drainedGuardTimeoutMs)
  return [next, [...precedingEffects, ...effects]]
}

// The user dismissed (closed) the sniffer webview. Only meaningful while parked
// on an `AwaitUserDismiss` hold, where it consumes the hold (cancelling its
// timeout) and drains on. A silent no-op in every other state (a hide adjacent
// to teardown, or a run without the step, must not disturb it); unlike a stray
// `PageLoaded` this is expected, so it does not WARN.
const onUserDismissed = (state: State.StepState, drainedGuardTimeoutMs: number): Transition =>
  state._tag === 'AwaitingUserDismiss'
    ? resumeFromUserDismissHold(state, [cancelTimer(state.generation)], drainedGuardTimeoutMs)
    : [state, []]

// The hold's own timeout elapsed: the user never closed the window. Wrap up the
// same way a dismissal would, but WARN — the plan expected a user action that
// never came, and the run's results are whatever was sniffed up to here.
const onUserDismissTimeoutFired = (
  state: State.StepState,
  generation: number,
  drainedGuardTimeoutMs: number
): Transition => {
  if (state._tag !== 'AwaitingUserDismiss' || state.generation !== generation) {
    return [state, []] // stale fire — the hold was already consumed or cleared
  }
  const head = state.queue[0]
  const timeoutMs =
    head !== undefined && head._tag === 'AwaitUserDismiss' ? Duration.toMillis(head.timeout) : 0
  return resumeFromUserDismissHold(
    state,
    [warnUserDismissTimeout(timeoutMs)],
    drainedGuardTimeoutMs
  )
}

// The sniffer webview was torn down. Only acted on while parked: the window the
// hold is waiting on no longer exists, so waiting out the remaining timeout
// would be pointless. Everywhere else it is a silent no-op — a dispose is also
// what this run's own `SniffingComplete` teardown produces, so one arrives on
// every run and must not be mistaken for a signal.
const onSnifferDisposed = (state: State.StepState, drainedGuardTimeoutMs: number): Transition =>
  state._tag === 'AwaitingUserDismiss'
    ? resumeFromUserDismissHold(
        state,
        [cancelTimer(state.generation), warnSnifferDisposed],
        drainedGuardTimeoutMs
      )
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
    // Every timer-bearing state must cancel here: the daemons are `forkDaemon`ed,
    // so one left running outlives the discarded machine (and the `ctx` it closes
    // over) for the rest of its sleep — a user-dismiss hold's `timeout` is
    // typically minutes.
    Match.tag('AwaitingUserDismiss', (s) => [
      State.awaitingPageLoaded(initialQueue, s.generation),
      [cancelTimer(s.generation)],
    ]),
    // `Drained` is timer-bearing too (the drained guard). Its sleep is a full
    // `drainedGuardTimeout`, so a daemon left running here would outlive the
    // discarded machine — and the `ctx` it closes over — for that whole span.
    Match.tag('Drained', (s) => [
      State.awaitingPageLoaded(initialQueue, s.generation),
      [cancelTimer(s.generation)],
    ]),
    Match.orElse((s) => [State.awaitingPageLoaded(initialQueue, s.generation), []])
  )

/**
 * The single transition table: `[state, input] → [state, effects]`, pure.
 * Routes on the input `_tag`, then each arm routes on the state `_tag`.
 * `initialQueue` is closed over only for `Stop`'s reset, and
 * `drainedGuardTimeoutMs` only to arm the guard every drain to an empty queue
 * installs.
 */
const transition =
  (initialQueue: State.Queue, drainedGuardTimeoutMs: number) =>
  (state: State.StepState, message: InputMessage): Transition =>
    Match.value(message).pipe(
      Match.withReturnType<Transition>(),
      Match.tag('Start', () => onStart(state, drainedGuardTimeoutMs)),
      Match.tag('PageLoaded', (m) => onPageLoaded(state, m.url, drainedGuardTimeoutMs)),
      Match.tag('PageRequested', (m) => onPageRequested(state, m.url, drainedGuardTimeoutMs)),
      Match.tag('DelayTimerFired', (m) =>
        onDelayTimerFired(state, m.generation, drainedGuardTimeoutMs)
      ),
      Match.tag('UrlMatchTimeoutFired', (m) =>
        onUrlMatchTimeoutFired(state, m.generation, drainedGuardTimeoutMs)
      ),
      Match.tag('UserDismissTimeoutFired', (m) =>
        onUserDismissTimeoutFired(state, m.generation, drainedGuardTimeoutMs)
      ),
      Match.tag('DrainedGuardTimeoutFired', (m) =>
        onDrainedGuardTimeoutFired(state, m.generation, drainedGuardTimeoutMs)
      ),
      Match.tag('StepsGenerated', (m) => onStepsGenerated(state, m.steps, drainedGuardTimeoutMs)),
      Match.tag('NoMoreResultsExpected', () => onNoMoreResultsExpected(state)),
      Match.tag('UserDismissed', () => onUserDismissed(state, drainedGuardTimeoutMs)),
      Match.tag('SnifferDisposed', () => onSnifferDisposed(state, drainedGuardTimeoutMs)),
      Match.tag('Stop', () => onStop(state, initialQueue)),
      Match.exhaustive
    )

export type { Transition }
export { transition }
