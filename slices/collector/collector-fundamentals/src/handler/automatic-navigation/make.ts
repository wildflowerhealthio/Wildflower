import { Effect, HashMap, Match, Ref, SynchronizedRef } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { RuntimeFiber } from 'effect/Fiber'

import type { CollectorBridge } from '../../bridge.ts'
import type { ScrapingPlan } from '../../model/index.ts'
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
 * `handlePageLoaded` handler, the settle-timer / URL-match-timeout daemons, and
 * `stopAutomaticNavigation` (this machine's share of the lifecycle's
 * `cancelAllRequestSniffing`). It interacts with the response tracker only
 * through the supplied `sendMessage`.
 */
interface AutomaticNavigation {
  readonly handlePageLoaded: Service['PageLoaded']
  /**
   * Halt the automatic navigation: interrupt any pending timer fiber and reset
   * the index to 0. This machine's contribution to the run lifecycle's
   * `cancelAllRequestSniffing`. There is no separate "reset vs fold" variant —
   * that teardown discards the machine right after, so the post-stop index is
   * never observed.
   */
  readonly stopAutomaticNavigation: () => Effect.Effect<void, never, never>
}

const make = <TResources>({
  scrapingPlan,
  sendMessage,
  onSniffingComplete,
}: {
  scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>
  sendMessage: (message: StepOutboundMessage) => Effect.Effect<void, never, never>
  /**
   * Run after the terminal `SniffingComplete` is dispatched (the
   * {@link DispatchSniffingComplete} side-effect). The composition wires this to
   * the {@link RunLifecycleState}'s `handleSniffingComplete`; the automatic
   * navigation treats it as an opaque effect, so the two machines still share
   * no state.
   */
  onSniffingComplete: Effect.Effect<void, never, never>
}): Effect.Effect<AutomaticNavigation, never, never> =>
  Effect.gen(function* () {
    const stepStateRef = yield* SynchronizedRef.make<StepState>(awaitingPageLoaded(0, 0))
    const registry: TimerRegistry = yield* Ref.make(
      HashMap.empty<number, RuntimeFiber<void, never>>()
    )
    const step = transition(scrapingPlan)

    // `dispatch` and `ctx` are mutually recursive (a timer daemon in a
    // handler re-injects an input via `ctx.dispatch`). The arrow closes
    // over the `dispatch` binding below; it is only *invoked* later, from
    // an already-forked daemon, so there is no temporal-dead-zone hazard.
    const ctx: HandlerContext<TResources> = {
      scrapingPlan,
      sendMessage,
      onSniffingComplete,
      dispatch: (message) => dispatch(message),
      getState: () => SynchronizedRef.get(stepStateRef),
      registry,
    }

    const runEffect = (effect: SideEffectMessage): Effect.Effect<void, never, never> =>
      Match.value(effect).pipe(
        Match.withReturnType<Effect.Effect<void, never, never>>(),
        Match.tag('DispatchStep', (m) => sideEffectHandlers.DispatchStep(m, ctx)),
        Match.tag('DispatchSniffingComplete', (m) =>
          sideEffectHandlers.DispatchSniffingComplete(m, ctx)
        ),
        Match.tag('ScheduleSettleTimer', (m) => sideEffectHandlers.ScheduleSettleTimer(m, ctx)),
        Match.tag('ScheduleUrlMatchTimeout', (m) =>
          sideEffectHandlers.ScheduleUrlMatchTimeout(m, ctx)
        ),
        Match.tag('CancelTimer', (m) => sideEffectHandlers.CancelTimer(m, ctx)),
        Match.tag('WarnUrlMatchTimeout', (m) => sideEffectHandlers.WarnUrlMatchTimeout(m, ctx)),
        Match.tag('WarnDroppedPageLoaded', (m) => sideEffectHandlers.WarnDroppedPageLoaded(m, ctx)),
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
    const stopAutomaticNavigation = (): Effect.Effect<void, never, never> =>
      dispatch({ _tag: 'Stop' })

    return { handlePageLoaded, stopAutomaticNavigation }
  })

export type { AutomaticNavigation }
export { make }
