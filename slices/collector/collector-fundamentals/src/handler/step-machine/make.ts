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
 * Part 6 of the step machine: the plumbing that turns the pure transition
 * table and its side-effect handlers into a live, serialized machine.
 */

type Service = MessageHandler.HandlersFor<CollectorBridge['HostToWeb']>

/**
 * The step-machine half of {@link CollectorBridgeMessageHandler}: the
 * `PageLoaded` handler, the settle-timer / URL-match-timeout daemons, and
 * this machine's share of `clear` / `cancelAllInFlight`. It interacts with
 * the response tracker only through the supplied `sendMessage`.
 */
interface StepMachine {
  readonly PageLoaded: Service['PageLoaded']
  /**
   * Interrupt any pending timer fiber and reset the index to 0. The step
   * machine's contribution to the composed `clear`.
   */
  readonly clear: () => Effect.Effect<void, never, never>
  /**
   * Interrupt any pending timer fiber and fold back to
   * `AwaitingPageLoaded` at the *same* index, so a future `PageLoaded`
   * re-attempts the step. The step machine's contribution to the composed
   * `cancelAllInFlight`.
   */
  readonly cancelAllInFlight: () => Effect.Effect<void, never, never>
}

const make = <TResources>({
  scrapingPlan,
  sendMessage,
}: {
  scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>
  sendMessage: (message: StepOutboundMessage) => Effect.Effect<void, never, never>
}): Effect.Effect<StepMachine, never, never> =>
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
      dispatch: (message) => dispatch(message),
      getState: () => SynchronizedRef.get(stepStateRef),
      registry,
    }

    const runEffect = (effect: SideEffectMessage): Effect.Effect<void, never, never> =>
      Match.value(effect).pipe(
        Match.withReturnType<Effect.Effect<void, never, never>>(),
        Match.tag('DispatchLink', (m) => sideEffectHandlers.DispatchLink(m, ctx)),
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
     * deliberately *not* `uninterruptible`: `clear` / `cancelAllInFlight`
     * interrupt a timer fiber while holding the lock, which would deadlock
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

    const PageLoaded: Service['PageLoaded'] = (event) => dispatch(event)
    const clear = (): Effect.Effect<void, never, never> => dispatch({ _tag: 'Clear' })
    const cancelAllInFlight = (): Effect.Effect<void, never, never> =>
      dispatch({ _tag: 'CancelAllInFlight' })

    return { PageLoaded, clear, cancelAllInFlight }
  })

export type { StepMachine }
export { make }
