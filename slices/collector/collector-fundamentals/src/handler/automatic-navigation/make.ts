import { Effect, HashMap, Match, Ref, SynchronizedRef } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { RuntimeFiber } from 'effect/Fiber'

import type { CollectorBridge } from '../../bridge.ts'
import type { ScrapingPlan } from '../../model/index.ts'
import type { Step } from '../../model/step.ts'
import type { InputMessage, SideEffectMessage, StepOutboundMessage } from './messages.ts'
import {
  type HandlerContext,
  sideEffectHandlers,
  type TimerRegistry,
} from './side-effect-handlers.ts'
import { awaitingPageLoaded, type StepState } from './state.ts'
import { transition } from './transition.ts'

/**
 * Part 6 of the automatic-navigation machine: the plumbing that turns the pure
 * transition table and its side-effect handlers into a live, serialized machine.
 */

type Service = MessageHandler.HandlersFor<CollectorBridge['HostToWeb']>

/**
 * The automatic-navigation half of {@link CollectorBridgeMessageHandler}: the
 * `handlePageLoaded` handler, the host-signal handlers (`handleUserDismissed` /
 * `handleSnifferDisposed`), the injection points the composition drives
 * (`handleStepsGenerated` / `signalNoMoreResultsExpected`), the delay /
 * URL-match / user-dismiss timeout daemons, and `stopAutomaticNavigation` (this
 * machine's share of the lifecycle teardown). It interacts with the response
 * tracker only through the supplied `sendMessage` and the injected hooks.
 */
interface AutomaticNavigation {
  readonly handlePageLoaded: Service['PageLoaded']
  /**
   * The early `PageRequested` page-arrival notification (fired at
   * `DOMContentLoaded`, before settlement). Consumed only by a parked
   * `AwaitPageRequested` hold; a silent no-op in every other state — in
   * particular it never starts the start-up drain, which stays gated on the
   * first settled `PageLoaded`.
   */
  readonly handlePageRequested: Service['PageRequested']
  /**
   * The external `UserDismissed` signal (the user closed the sniffer webview),
   * forwarded from the host on the `CollectorBridge`. Consumes an
   * `AwaitUserDismiss` hold the machine is parked on and resumes draining; a
   * silent no-op in every other state. It does not end the run on its own —
   * completion still goes through the usual drained-and-settled gate.
   */
  readonly handleUserDismissed: Service['UserDismissed']
  /**
   * The external `SnifferDisposed` signal (the sniffer webview was torn down),
   * forwarded from the host on the `CollectorBridge`. Only acted on while parked
   * on an `AwaitUserDismiss` hold, where the window being waited on no longer
   * exists so the machine wraps up instead of waiting out the hold's timeout. A
   * silent no-op everywhere else — this run's own teardown produces a dispose
   * too.
   */
  readonly handleSnifferDisposed: Service['SnifferDisposed']
  /**
   * Append `followUpSteps`-generated steps to the back of the queue (the
   * composition dedups/caps them first). From `Drained` this re-awakens the
   * machine and dispatches the new head without waiting for a `PageLoaded`.
   */
  readonly handleStepsGenerated: (steps: readonly Step[]) => Effect.Effect<void, never, never>
  /**
   * Signal that no sniffed request is still incomplete. Completes the run
   * (`Drained → Done`, dispatching `SniffingComplete`) or is a no-op if the
   * queue is not yet drained. The lifecycle injects this after a settle empties
   * the incomplete-request map, and the `onDrained` hook re-injects it when the
   * queue drains onto an already-empty map.
   */
  readonly signalNoMoreResultsExpected: Effect.Effect<void, never, never>
  /**
   * Halt the automatic navigation: interrupt any pending timer fiber and restore
   * the initial queue. This machine's contribution to the lifecycle's
   * `cancelAllRequestSniffing` / `abandonAllRequestSniffing`. There is no
   * separate "reset vs fold" variant — that teardown discards the machine right
   * after, so the restored queue is never observed.
   */
  readonly stopAutomaticNavigation: () => Effect.Effect<void, never, never>
}

const make = <TResources>({
  scrapingPlan,
  sendMessage,
  onSniffingComplete,
  onDrained,
}: {
  scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>
  sendMessage: (message: StepOutboundMessage) => Effect.Effect<void, never, never>
  /**
   * Run after the terminal `SniffingComplete` is dispatched. The composition
   * wires this to the {@link RunLifecycleState}'s `handleSniffingComplete`; the
   * automatic navigation treats it as an opaque effect, so the two machines
   * still share no state.
   */
  onSniffingComplete: Effect.Effect<void, never, never>
  /**
   * Run (forked) when the queue drains. The composition wires this to a
   * lifecycle check that re-injects `NoMoreResultsExpected` iff no request is
   * still incomplete — closing the "map emptied before the queue drained" gap
   * (e.g. a trailing `Delay`) that a settle-only trigger would leave hanging.
   */
  onDrained: Effect.Effect<void, never, never>
}): Effect.Effect<AutomaticNavigation, never, never> =>
  Effect.gen(function* () {
    const initialQueue = scrapingPlan.stepSequence
    const stepStateRef = yield* SynchronizedRef.make<StepState>(awaitingPageLoaded(initialQueue, 0))
    const registry: TimerRegistry = yield* Ref.make(
      HashMap.empty<number, RuntimeFiber<void, never>>()
    )
    const step = transition(initialQueue)

    // `dispatch` and `ctx` are mutually recursive (a timer daemon / the
    // completion-check daemon re-injects an input via `ctx.dispatch`). The arrow
    // closes over the `dispatch` binding below; it is only *invoked* later, from
    // an already-forked daemon, so there is no temporal-dead-zone hazard.
    const ctx: HandlerContext = {
      sendMessage,
      onSniffingComplete,
      onDrained,
      dispatch: (message) => dispatch(message),
      registry,
    }

    const runEffect = (effect: SideEffectMessage): Effect.Effect<void, never, never> =>
      Match.value(effect).pipe(
        Match.withReturnType<Effect.Effect<void, never, never>>(),
        Match.tag('SetStepName', (m) => sideEffectHandlers.SetStepName(m, ctx)),
        Match.tag('DispatchNavigation', (m) => sideEffectHandlers.DispatchNavigation(m, ctx)),
        Match.tag('DispatchSniffingComplete', (m) =>
          sideEffectHandlers.DispatchSniffingComplete(m, ctx)
        ),
        Match.tag('DispatchEnsureVisible', (m) => sideEffectHandlers.DispatchEnsureVisible(m, ctx)),
        Match.tag('ScheduleDelayTimer', (m) => sideEffectHandlers.ScheduleDelayTimer(m, ctx)),
        Match.tag('ScheduleUrlMatchTimeout', (m) =>
          sideEffectHandlers.ScheduleUrlMatchTimeout(m, ctx)
        ),
        Match.tag('ScheduleUserDismissTimeout', (m) =>
          sideEffectHandlers.ScheduleUserDismissTimeout(m, ctx)
        ),
        Match.tag('CancelTimer', (m) => sideEffectHandlers.CancelTimer(m, ctx)),
        Match.tag('RequestCompletionCheck', (m) =>
          sideEffectHandlers.RequestCompletionCheck(m, ctx)
        ),
        Match.tag('WarnUrlMatchTimeout', (m) => sideEffectHandlers.WarnUrlMatchTimeout(m, ctx)),
        Match.tag('WarnUrlMatchAdvanced', (m) => sideEffectHandlers.WarnUrlMatchAdvanced(m, ctx)),
        Match.tag('WarnUserDismissTimeout', (m) =>
          sideEffectHandlers.WarnUserDismissTimeout(m, ctx)
        ),
        Match.tag('WarnSnifferDisposed', (m) => sideEffectHandlers.WarnSnifferDisposed(m, ctx)),
        Match.tag('WarnDroppedPageLoaded', (m) => sideEffectHandlers.WarnDroppedPageLoaded(m, ctx)),
        Match.tag('WarnDroppedSteps', (m) => sideEffectHandlers.WarnDroppedSteps(m, ctx)),
        Match.exhaustive
      )

    /**
     * Apply one input atomically: under the `SynchronizedRef` lock compute
     * `[next, effects]` from the pure transition, commit `next`, and run the
     * effects in order — all in one critical section. The body is
     * deliberately *not* `uninterruptible`: `stopAutomaticNavigation`
     * interrupts a timer fiber while holding the lock, which would deadlock
     * inside an uninterruptible region. See
     * [Handler Explanation](../../../docs/Handler%20Explanation.md#why-dispatch-is-not-uninterruptible).
     */
    const dispatch = (message: InputMessage): Effect.Effect<void, never, never> =>
      SynchronizedRef.updateEffect(stepStateRef, (state) =>
        Effect.gen(function* () {
          const [next, effects] = step(state, message)
          yield* Effect.forEach(effects, runEffect, { discard: true })
          return next
        })
      )

    const handlePageLoaded: Service['PageLoaded'] = (event) => dispatch(event)
    const handlePageRequested: Service['PageRequested'] = (event) => dispatch(event)
    const handleUserDismissed: Service['UserDismissed'] = () => dispatch({ _tag: 'UserDismissed' })
    const handleSnifferDisposed: Service['SnifferDisposed'] = () =>
      dispatch({ _tag: 'SnifferDisposed' })
    const handleStepsGenerated = (steps: readonly Step[]): Effect.Effect<void, never, never> =>
      dispatch({ _tag: 'StepsGenerated', steps })
    const signalNoMoreResultsExpected: Effect.Effect<void, never, never> = dispatch({
      _tag: 'NoMoreResultsExpected',
    })
    const stopAutomaticNavigation = (): Effect.Effect<void, never, never> =>
      dispatch({ _tag: 'Stop' })

    return {
      handlePageLoaded,
      handlePageRequested,
      handleUserDismissed,
      handleSnifferDisposed,
      handleStepsGenerated,
      signalNoMoreResultsExpected,
      stopAutomaticNavigation,
    }
  })

export type { AutomaticNavigation }
export { make }
