import { Duration, Effect, Fiber, HashMap, Option, Ref } from 'effect'
import type { RuntimeFiber } from 'effect/Fiber'

import type { ScrapingPlan } from '../../model/index.ts'
import * as Telemetry from '../../telemetry/index.ts'
import type { InputMessage, StepOutboundMessage } from './messages.ts'
import type { StepState } from './state.ts'

/**
 * Part 4 of the step machine: the side-effect handlers.
 *
 * One handler per side-effect message `_tag`, each `(msg, ctx) =>
 * Effect<void>`. The interpreter in `./make.ts` routes to these; they
 * close over nothing but their arguments. `Schedule*` fork span-wrapped
 * daemons that re-inject a `*Fired` input; `CancelTimer` interrupts a
 * registered daemon; `Dispatch*` send bridge messages; `Warn*` log.
 */

/** Live timer fibers, keyed by the generation they were scheduled under. */
type TimerRegistry = Ref.Ref<HashMap.HashMap<number, RuntimeFiber<void, never>>>

/**
 * The environment a side-effect handler runs in: the plan and bridge
 * sender it needs, `dispatch` so a timer daemon can re-inject its `*Fired`
 * input, `getState` for handlers that want the committed state, and the
 * timer registry that backs `Schedule*` / `CancelTimer`.
 */
interface HandlerContext<TResources> {
  readonly scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>
  readonly sendMessage: (message: StepOutboundMessage) => Effect.Effect<void, never, never>
  readonly dispatch: (message: InputMessage) => Effect.Effect<void, never, never>
  readonly getState: () => Effect.Effect<StepState, never, never>
  readonly registry: TimerRegistry
}

/**
 * Fork the span-wrapped settle/timeout daemon and register its fiber. On
 * expiry it removes itself from the registry (so a later `CancelTimer` is
 * a harmless no-op) then re-injects `fired` through `ctx.dispatch`, which
 * re-acquires the machine's lock. If the state has moved on, the
 * generation guard in the transition drops the fire.
 */
const scheduleTimerDaemon = <TResources>(
  ctx: HandlerContext<TResources>,
  options: {
    readonly generation: number
    readonly duration: Duration.Duration
    readonly spanName: string
    readonly spanAttributes: Record<string, string | number>
    readonly fired: InputMessage
  }
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkDaemon(
      Effect.gen(function* () {
        yield* Effect.sleep(options.duration).pipe(
          Effect.withSpan(options.spanName, { attributes: options.spanAttributes })
        )
        yield* Ref.update(ctx.registry, HashMap.remove(options.generation))
        yield* ctx.dispatch(options.fired)
      })
    )
    yield* Ref.update(ctx.registry, HashMap.set(options.generation, fiber))
  })

const sideEffectHandlers = {
  DispatchStep: <TResources>(
    msg: { readonly dispatchIndex: number },
    ctx: HandlerContext<TResources>
  ): Effect.Effect<void, never, never> => {
    // A step is `{ action; advanceWhen? }`, and `action` is already a bridge
    // message body — forward it straight to the sniffer. The plan-only
    // `advanceWhen` lives on the wrapper, never on the action, so it cannot
    // leak onto the wire (no destructure-and-strip needed).
    const { action } = ctx.scrapingPlan.stepSequence[msg.dispatchIndex]
    // Low-cardinality telemetry: the action tag, plus the inner `kind` for a
    // `PageAction` (`PageAction:Click` / `PageAction:Fill`).
    const linkKind =
      action._tag === 'PageAction' ? `${action._tag}:${action.action.kind}` : action._tag
    return ctx.sendMessage(action).pipe(
      Effect.withSpan(Telemetry.Sniffing.Dispatch.Span.Name, {
        attributes: {
          [Telemetry.Sniffing.Attributes.StepIndex]: msg.dispatchIndex,
          [Telemetry.Sniffing.Attributes.LinkKind]: linkKind,
        },
      })
    )
  },
  DispatchSniffingComplete: <TResources>(
    msg: { readonly dispatchIndex: number },
    ctx: HandlerContext<TResources>
  ): Effect.Effect<void, never, never> =>
    ctx.sendMessage({ _tag: 'SniffingComplete' }).pipe(
      Effect.withSpan(Telemetry.Sniffing.Dispatch.Span.Name, {
        attributes: {
          [Telemetry.Sniffing.Attributes.StepIndex]: msg.dispatchIndex,
          [Telemetry.Sniffing.Attributes.LinkKind]: 'SniffingComplete',
        },
      })
    ),
  ScheduleSettleTimer: <TResources>(
    msg: { readonly dispatchIndex: number; readonly generation: number },
    ctx: HandlerContext<TResources>
  ): Effect.Effect<void, never, never> =>
    scheduleTimerDaemon(ctx, {
      generation: msg.generation,
      duration: ctx.scrapingPlan.stepDelay,
      spanName: Telemetry.Sniffing.Wait.Span.Name,
      spanAttributes: {
        [Telemetry.Sniffing.Attributes.StepIndex]: msg.dispatchIndex,
        [Telemetry.Sniffing.Attributes.StepDelayMs]: Duration.toMillis(ctx.scrapingPlan.stepDelay),
      },
      fired: { _tag: 'SettleTimerFired', generation: msg.generation },
    }),
  ScheduleUrlMatchTimeout: <TResources>(
    msg: {
      readonly dispatchIndex: number
      readonly generation: number
      readonly timeoutMs: number
    },
    ctx: HandlerContext<TResources>
  ): Effect.Effect<void, never, never> =>
    scheduleTimerDaemon(ctx, {
      generation: msg.generation,
      duration: Duration.millis(msg.timeoutMs),
      spanName: Telemetry.Sniffing.UrlMatchWait.Span.Name,
      spanAttributes: {
        [Telemetry.Sniffing.Attributes.StepIndex]: msg.dispatchIndex,
        [Telemetry.Sniffing.Attributes.UrlMatchTimeoutMs]: msg.timeoutMs,
      },
      fired: { _tag: 'UrlMatchTimeoutFired', generation: msg.generation },
    }),
  CancelTimer: <TResources>(
    msg: { readonly generation: number },
    ctx: HandlerContext<TResources>
  ): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const registered = HashMap.get(yield* Ref.get(ctx.registry), msg.generation)
      if (Option.isSome(registered)) {
        yield* Ref.update(ctx.registry, HashMap.remove(msg.generation))
        yield* Fiber.interrupt(registered.value)
      }
    }),
  WarnUrlMatchTimeout: <TResources>(
    msg: { readonly dispatchIndex: number; readonly timeoutMs: number },
    _ctx: HandlerContext<TResources>
  ): Effect.Effect<void, never, never> =>
    Effect.logWarning(
      `CollectorBridgeMessageHandler.PageLoaded: URL-match step ${msg.dispatchIndex} timed out after ${msg.timeoutMs}ms with no matching PageLoaded; aborting via SniffingComplete`
    ),
  WarnDroppedPageLoaded: <TResources>(
    msg: { readonly url: string },
    _ctx: HandlerContext<TResources>
  ): Effect.Effect<void, never, never> =>
    Effect.logWarning(
      `CollectorBridgeMessageHandler.PageLoaded: handler is done; ignoring (url=${msg.url})`
    ),
} as const

export type { HandlerContext, TimerRegistry }
export { sideEffectHandlers }
