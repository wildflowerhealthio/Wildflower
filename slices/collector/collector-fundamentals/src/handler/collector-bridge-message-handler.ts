import { type CancelSnifferRequestMessage, type PageActionMessage } from 'browser-sniffer-core'
import { Effect, type Either, type MutableHashMap, type ParseResult } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { UnknownException } from 'effect/Cause'
import type {
  CollectorBridge,
  OpenMessage,
  SniffingComplete as SniffingCompleteMessage,
} from '../bridge.ts'
import type { Response, ScrapingPlan } from '../model/index.ts'
import * as ResponseTracker from './response-tracker.ts'
import { type InProgressResponse, SnifferCancelled } from './response-tracker.ts'
import * as StepMachine from './step-machine/index.ts'

type Service = MessageHandler.HandlersFor<CollectorBridge['HostToWeb']>

/**
 * The union of every message the handler can ask the host to send via
 * the supplied `sendMessage`. `CancelSnifferRequest` short-circuits an
 * unmatched response stream (response tracker); `Open` / `PageAction`
 * drive the scripted navigation and `SniffingComplete` is the terminal
 * hand-off when the link sequence is exhausted (step machine). The
 * `Open` / `PageAction` payloads *are* the step's `action` — the handler
 * forwards `scrapingPlan.linkSequence[i].action` to `sendMessage` without
 * translation (the plan-only `advanceWhen` rides the step wrapper, never
 * the action).
 */
type OutboundMessage =
  | typeof CancelSnifferRequestMessage.Type
  | typeof OpenMessage.Type
  | typeof PageActionMessage.Type
  | typeof SniffingCompleteMessage.Type

interface CollectorBridgeMessageHandler<TResources> extends Service {
  readonly inProgressResponses: MutableHashMap.MutableHashMap<
    string,
    InProgressResponse<TResources>
  >
  /**
   * Drop every in-flight tracked response and interrupt the pending
   * step-timer fiber without emitting an `onResult`. Use from a
   * screen-unmount / sync-abandoned path to release buffered chunks —
   * the host alone knows when the sniffer is permanently silent for a
   * session, so the handler can't time entries out on its own.
   */
  readonly clear: () => Effect.Effect<void, never, never>
  /**
   * Build an Effect that dispatches a `CancelSnifferRequest` through
   * the supplied `send` for every currently in-flight id, and also
   * interrupts the pending step-timer fiber. Pair with `clear()` from
   * a screen-unmount path so the page stops streaming bytes that
   * would otherwise be log-and-dropped by the runtime provider once
   * the handler ref is null.
   *
   * The Effect runs each cancel sequentially; consumers typically
   * `Effect.runFork` it during a synchronous React cleanup, then call
   * `clear()` to drop the local tracking state.
   */
  readonly cancelAllInFlight: (
    send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
  ) => Effect.Effect<void, never, never>
}

/**
 * Compose the response tracker and step machine — two independent
 * machines that interact only via the supplied `sendMessage` — into the
 * single `CollectorBridgeMessageHandler` public surface. Each machine
 * owns its handlers and its share of `clear` / `cancelAllInFlight`; this
 * function threads the shared inputs into both and folds their
 * `clear` / `cancelAllInFlight` contributions together (step machine
 * first — interrupt its fibers — then the response tracker). That order
 * is preserved from the pre-split handler but is not load-bearing: the
 * machines share no state, so neither can observe the other mid-teardown.
 * See the [Handler Explanation](../../docs/Handler%20Explanation.md) for
 * the composition rationale and the two machines' invariants.
 */
const make = <TResources>({
  scrapingPlan,
  sendMessage,
  onResult,
}: {
  scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>
  sendMessage: (message: OutboundMessage) => Effect.Effect<void, never, never>
  onResult: (args: {
    readonly response: Response.RemoteResponse
    readonly result: Either.Either<
      readonly TResources[],
      ParseResult.ParseError | UnknownException | SnifferCancelled
    >
  }) => void
}): Effect.Effect<CollectorBridgeMessageHandler<TResources>, never, never> =>
  Effect.gen(function* () {
    const tracker = yield* ResponseTracker.make<TResources>({
      scrapingPlan,
      sendMessage,
      onResult,
    })
    const stepMachine = yield* StepMachine.make<TResources>({ scrapingPlan, sendMessage })

    const clear = (): Effect.Effect<void, never, never> =>
      stepMachine.clear().pipe(Effect.andThen(tracker.clear()))

    const cancelAllInFlight = (
      send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
    ): Effect.Effect<void, never, never> =>
      stepMachine.cancelAllInFlight().pipe(Effect.andThen(tracker.cancelAllInFlight(send)))

    return {
      inProgressResponses: tracker.inProgressResponses,
      clear,
      cancelAllInFlight,
      ResponseStart: tracker.ResponseStart,
      ResponseData: tracker.ResponseData,
      ResponseFinished: tracker.ResponseFinished,
      RequestError: tracker.RequestError,
      Cancelled: tracker.Cancelled,
      PageLoaded: stepMachine.PageLoaded,
    }
  })

export type { CollectorBridgeMessageHandler, InProgressResponse, OutboundMessage }
export { make, SnifferCancelled }
