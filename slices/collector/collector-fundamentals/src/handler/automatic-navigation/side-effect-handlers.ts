import { Duration, Effect, Fiber, HashMap, Option, Ref } from 'effect'
import type { RuntimeFiber } from 'effect/Fiber'

import type { StepAction } from '../../model/step.ts'
import * as Telemetry from '../../telemetry/index.ts'
import type { InputMessage, StepOutboundMessage } from './messages.ts'

/**
 * Part 4 of the automatic-navigation machine: the side-effect handlers.
 *
 * One handler per side-effect message `_tag`, each `(msg, ctx) =>
 * Effect<void>`. The interpreter in `./make.ts` routes to these; they
 * close over nothing but their arguments. `Schedule*` fork span-wrapped
 * daemons that re-inject a `*Fired` input; `CancelTimer` interrupts a
 * registered daemon; `Dispatch*` send bridge messages; `RequestCompletionCheck`
 * forks the drained-completion check; `Warn*` log.
 */

/** Live timer fibers, keyed by the generation they were scheduled under. */
type TimerRegistry = Ref.Ref<HashMap.HashMap<number, RuntimeFiber<void, never>>>

/**
 * The environment a side-effect handler runs in: the bridge sender it needs,
 * the completion hooks (`onSniffingComplete` after the terminal message,
 * `onDrained` when the queue empties), `dispatch` so a timer daemon can
 * re-inject its `*Fired` input, and the timer registry that backs `Schedule*` /
 * `CancelTimer`.
 */
interface HandlerContext {
  readonly sendMessage: (message: StepOutboundMessage) => Effect.Effect<void, never, never>
  /**
   * Run right after the terminal `SniffingComplete` is sent to the host, inside
   * the same span. The composition wires this to the {@link RunLifecycleState}'s
   * `handleSniffingComplete`, so the run's completion is an explicit hook rather
   * than a tag match on the outbound message — the automatic-navigation machine
   * still reads no shared state.
   */
  readonly onSniffingComplete: Effect.Effect<void, never, never>
  /**
   * Run (forked) when the queue drains to `Drained`. The composition wires this
   * to a lifecycle check that re-injects `NoMoreResultsExpected` iff no sniffed
   * request is still incomplete — so completion is re-evaluated whenever *either*
   * fact (queue drained / requests settled) becomes true. Forked by
   * `RequestCompletionCheck` so its `dispatch` re-enters the lock *after* the
   * current transition commits.
   */
  readonly onDrained: Effect.Effect<void, never, never>
  readonly dispatch: (message: InputMessage) => Effect.Effect<void, never, never>
  readonly registry: TimerRegistry
}

/**
 * Fork the span-wrapped timer daemon and register its fiber. On expiry it
 * removes itself from the registry (so a later `CancelTimer` is a harmless
 * no-op) then re-injects `fired` through `ctx.dispatch`, which re-acquires the
 * machine's lock. If the state has moved on, the generation guard in the
 * transition drops the fire.
 */
const scheduleTimerDaemon = (
  ctx: HandlerContext,
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

/** Low-cardinality dispatch label: the action tag, `PageAction`'s inner `kind` appended. */
const linkKindOf = (action: StepAction): string =>
  action._tag === 'PageAction' ? `${action._tag}:${action.action.kind}` : action._tag

const sideEffectHandlers = {
  DispatchNavigation: (
    msg: { readonly action: StepAction },
    ctx: HandlerContext
  ): Effect.Effect<void, never, never> =>
    // A `Navigation` step's `action` is already a bridge message body — forward
    // it straight to the sniffer. The plan-only `advanceWhen` lived on the step
    // wrapper, never on the action, so it cannot leak onto the wire (no
    // destructure-and-strip needed), and a `Delay` never reaches here.
    ctx.sendMessage(msg.action).pipe(
      Effect.withSpan(Telemetry.Sniffing.Dispatch.Span.Name, {
        attributes: { [Telemetry.Sniffing.Attributes.LinkKind]: linkKindOf(msg.action) },
      })
    ),
  DispatchSniffingComplete: (
    _msg: { readonly _tag: 'DispatchSniffingComplete' },
    ctx: HandlerContext
  ): Effect.Effect<void, never, never> =>
    // Send the terminal message to the host, then run the completion hook — both
    // inside the one span, matching the pre-hook order (send, then signal).
    ctx.sendMessage({ _tag: 'SniffingComplete' }).pipe(
      Effect.andThen(ctx.onSniffingComplete),
      Effect.withSpan(Telemetry.Sniffing.Dispatch.Span.Name, {
        attributes: { [Telemetry.Sniffing.Attributes.LinkKind]: 'SniffingComplete' },
      })
    ),
  ScheduleDelayTimer: (
    msg: { readonly generation: number; readonly durationMs: number },
    ctx: HandlerContext
  ): Effect.Effect<void, never, never> =>
    scheduleTimerDaemon(ctx, {
      generation: msg.generation,
      duration: Duration.millis(msg.durationMs),
      spanName: Telemetry.Sniffing.Wait.Span.Name,
      spanAttributes: { [Telemetry.Sniffing.Attributes.DelayMs]: msg.durationMs },
      fired: { _tag: 'DelayTimerFired', generation: msg.generation },
    }),
  ScheduleUrlMatchTimeout: (
    msg: { readonly generation: number; readonly timeoutMs: number },
    ctx: HandlerContext
  ): Effect.Effect<void, never, never> =>
    scheduleTimerDaemon(ctx, {
      generation: msg.generation,
      duration: Duration.millis(msg.timeoutMs),
      spanName: Telemetry.Sniffing.UrlMatchWait.Span.Name,
      spanAttributes: { [Telemetry.Sniffing.Attributes.UrlMatchTimeoutMs]: msg.timeoutMs },
      fired: { _tag: 'UrlMatchTimeoutFired', generation: msg.generation },
    }),
  CancelTimer: (
    msg: { readonly generation: number },
    ctx: HandlerContext
  ): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const registered = HashMap.get(yield* Ref.get(ctx.registry), msg.generation)
      if (Option.isSome(registered)) {
        yield* Ref.update(ctx.registry, HashMap.remove(msg.generation))
        yield* Fiber.interrupt(registered.value)
      }
    }),
  RequestCompletionCheck: (
    _msg: { readonly _tag: 'RequestCompletionCheck' },
    ctx: HandlerContext
  ): Effect.Effect<void, never, never> =>
    // Fork the lifecycle's completion check so its `dispatch(NoMoreResultsExpected)`
    // re-enters the machine's lock *after* this transition commits, exactly like
    // a timer daemon — never re-entrant inside the held lock.
    Effect.asVoid(Effect.forkDaemon(ctx.onDrained)),
  WarnUrlMatchTimeout: (
    msg: { readonly timeoutMs: number },
    _ctx: HandlerContext
  ): Effect.Effect<void, never, never> =>
    Effect.logWarning(
      `CollectorBridgeMessageHandler.PageLoaded: URL-match step timed out after ${msg.timeoutMs}ms with no matching PageLoaded; aborting via SniffingComplete`
    ),
  WarnDroppedPageLoaded: (
    msg: { readonly url: string },
    _ctx: HandlerContext
  ): Effect.Effect<void, never, never> =>
    Effect.logWarning(
      `CollectorBridgeMessageHandler.PageLoaded: handler is done; ignoring (url=${msg.url})`
    ),
  WarnDroppedSteps: (
    msg: { readonly count: number },
    _ctx: HandlerContext
  ): Effect.Effect<void, never, never> =>
    Effect.logWarning(
      `CollectorBridgeMessageHandler: ${msg.count} follow-up step(s) generated after the run completed; dropping`
    ),
} as const

export type { HandlerContext, TimerRegistry }
export { sideEffectHandlers }
