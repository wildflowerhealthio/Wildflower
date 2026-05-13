import { type CancelSnifferRequestMessage, type ClickMessage } from 'browser-sniffer-core'
import { Response, type ScrapingPlan } from 'collector-fundamentals/model'
import {
  Data,
  Effect,
  Either,
  Encoding,
  Fiber,
  MutableHashMap,
  MutableRef,
  Option,
  type ParseResult,
} from 'effect'
import { UnknownException } from 'effect/Cause'
import type CollectorBridge from '../bridge.ts'
import type { OpenMessage, SniffingComplete as SniffingCompleteMessage } from '../bridge.ts'
import type * as EntityDefinition from '../model/entity-definition.ts'

type Service = CollectorBridge['Web']['HandlerTag']['Service']

/**
 * Per-id state for an in-flight tracked response. `entity` is pinned
 * at `ResponseStart` so `ResponseFinished` / `RequestError` don't
 * re-walk `entityDefinitions` (and so a hypothetical mutation of the
 * remote between Start and Finish couldn't reroute parsing — the
 * factory now deep-freezes anyway, but this nails the invariant).
 */
interface InProgressResponse<TResources> {
  readonly response: Response.RemoteResponse
  readonly entity: EntityDefinition.EntityDefinition<TResources>
}

/**
 * Terminal-error tag delivered to `onResult` when the page acknowledges
 * a `CancelSnifferRequest` mid-stream with a `Cancelled` event. Carries
 * the sniffer request id for downstream correlation.
 */
class SnifferCancelled extends Data.TaggedError('SnifferCancelled')<{
  readonly id: string
}> {}

/**
 * The union of every message the handler can ask the host to send via
 * the supplied `sendMessage`. `CancelSnifferRequest` short-circuits an
 * unmatched response stream; `Open` / `Click` drive the scripted
 * navigation; `SniffingComplete` is the terminal hand-off when the
 * link sequence is exhausted. The `Open` / `Click` payload shape
 * matches `Link.Open` / `Link.Click` exactly — the handler forwards
 * `scrapingPlan.linkSequence[i]` to `sendMessage` without translation.
 */
type OutboundMessage =
  | typeof CancelSnifferRequestMessage.Type
  | typeof OpenMessage.Type
  | typeof ClickMessage.Type
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
  readonly clear: () => void
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

const make = <TResources>({
  scrapingPlan,
  sendMessage,
  onResult: handleResult,
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
}): CollectorBridgeMessageHandler<TResources> => {
  const inProgressResponses = MutableHashMap.empty<string, InProgressResponse<TResources>>()

  // Step-driver state. `stepFiber` holds the most-recent forked daemon
  // so a re-arming PageLoaded can interrupt it; `currentLinkIndex` is
  // the index of the *next* link to dispatch (sequence is exhausted
  // when it equals `linkSequence.length`, at which point the next
  // PageLoaded schedules `SniffingComplete`); `runState` flips to
  // 'done' after `SniffingComplete` is sent so subsequent PageLoaded
  // events are logged-and-dropped.
  const stepFiber = MutableRef.make<Fiber.RuntimeFiber<void, never> | null>(null)
  const currentLinkIndex = MutableRef.make(0)
  const runState = MutableRef.make<'running' | 'done'>('running')

  /**
   * Fire-and-forget interrupt of the pending step fiber, if any.
   * Interrupting an already-completed fiber is a no-op. Used from
   * synchronous teardown paths (`clear`) where we don't want to await
   * the interrupt's completion.
   */
  const interruptStepFiber = (): void => {
    const fiber = MutableRef.get(stepFiber)
    if (fiber !== null) {
      Effect.runFork(Fiber.interrupt(fiber))
      MutableRef.set(stepFiber, null)
    }
  }

  /**
   * Compute the next step's payload from the current `currentLinkIndex`.
   * Once the sequence is exhausted, the payload becomes
   * `SniffingComplete` — the post-send transition flips `runState` to
   * `'done'` so subsequent PageLoaded events warn-and-no-op.
   */
  const nextStepAction = (): Effect.Effect<void, never, never> => {
    const i = MutableRef.get(currentLinkIndex)
    if (i >= scrapingPlan.linkSequence.length) {
      return Effect.gen(function* () {
        yield* Effect.sleep(scrapingPlan.stepDelay)
        yield* sendMessage({ _tag: 'SniffingComplete' })
        MutableRef.set(runState, 'done')
        MutableRef.set(stepFiber, null)
      })
    }
    const link = scrapingPlan.linkSequence[i]
    return Effect.gen(function* () {
      yield* Effect.sleep(scrapingPlan.stepDelay)
      // `Link.Open` / `Link.Click` are structurally identical to the
      // `Open` / `Click` bridge messages (same `_tag`, same fields),
      // so the link value is the wire payload — no translation step.
      yield* sendMessage(link)
      MutableRef.set(currentLinkIndex, i + 1)
      MutableRef.set(stepFiber, null)
    })
  }

  const ResponseStart: Service['ResponseStart'] = (event) => {
    const entity = scrapingPlan.entityDefinitions.find((e) => e.isFoundAt(event.url))
    if (entity === undefined) {
      return sendMessage({
        _tag: 'CancelSnifferRequest',
        id: event.id,
      } satisfies typeof CancelSnifferRequestMessage.Type)
    }
    MutableHashMap.set(event.id, {
      response: new Response.RemoteResponse(
        event.url,
        event.status,
        event.statusText,
        event.headers
      ),
      entity,
    })(inProgressResponses)
    return Effect.void
  }

  const ResponseData: Service['ResponseData'] = (event) =>
    Effect.gen(function* () {
      const maybe = MutableHashMap.get(event.id)(inProgressResponses)
      if (Option.isNone(maybe)) {
        yield* Effect.logWarning(
          `CollectorBridgeMessageHandler.ResponseData: no tracked response for id ${event.id}; ignoring`
        )
        return
      }
      const { response } = maybe.value
      const decoded = Encoding.decodeBase64(event.data)
      if (Either.isLeft(decoded)) {
        // Decode failure on a *tracked* response: route through the
        // error channel of `onResult` (mirrors the `RequestError`
        // shape) and drop the entry. The host gets one terminal
        // observation per id; no chunk is appended.
        MutableHashMap.remove(inProgressResponses, event.id)
        handleResult({
          response,
          result: Either.left(
            new UnknownException(decoded.left, `Failed to decode base64 response data`)
          ),
        })
        return
      }
      response.appendChunk(decoded.right)
    })

  const ResponseFinished: Service['ResponseFinished'] = (event) =>
    Effect.gen(function* () {
      const maybe = MutableHashMap.get(event.id)(inProgressResponses)
      if (Option.isNone(maybe)) {
        yield* Effect.logWarning(
          `CollectorBridgeMessageHandler.ResponseFinished: no tracked response for id ${event.id}; ignoring`
        )
        return
      }
      const { response, entity } = maybe.value
      MutableHashMap.remove(inProgressResponses, event.id)
      const result = yield* Effect.either(entity.parse(response))
      handleResult({ response, result })
    })

  const RequestError: Service['RequestError'] = (event) =>
    Effect.gen(function* () {
      const maybe = MutableHashMap.get(event.id)(inProgressResponses)
      if (Option.isNone(maybe)) {
        yield* Effect.logWarning(
          `CollectorBridgeMessageHandler.RequestError: no tracked response for id ${event.id}; ignoring`
        )
        return
      }
      // `event.url` is intentionally ignored — the URL captured at
      // `ResponseStart` is the source of truth for routing, and the
      // entity has already been pinned at Start. If the sniffer ever
      // reports a redirected URL in `event.url` the divergence is not
      // load-bearing for parsing (we never re-route here); the start
      // URL stays on `response.url` for the consumer's inspection.
      const { response } = maybe.value
      MutableHashMap.remove(inProgressResponses, event.id)
      handleResult({ response, result: Either.left(new UnknownException(event.message)) })
    })

  const Cancelled: Service['Cancelled'] = (event) =>
    Effect.gen(function* () {
      const maybe = MutableHashMap.get(event.id)(inProgressResponses)
      if (Option.isNone(maybe)) {
        // `Cancelled` is sent by the page in response to a
        // `CancelSnifferRequest` the host issued; an unsolicited
        // `Cancelled` (or one for an id already finished) is harmless.
        yield* Effect.logWarning(
          `CollectorBridgeMessageHandler.Cancelled: no tracked response for id ${event.id}; ignoring`
        )
        return
      }
      const { response } = maybe.value
      MutableHashMap.remove(inProgressResponses, event.id)
      handleResult({
        response,
        result: Either.left(new SnifferCancelled({ id: event.id })),
      })
    })

  const PageLoaded: Service['PageLoaded'] = (event) =>
    Effect.gen(function* () {
      if (MutableRef.get(runState) === 'done') {
        yield* Effect.logWarning(
          `CollectorBridgeMessageHandler.PageLoaded: handler is done; ignoring (url=${event.url})`
        )
        return
      }
      // Cancel any pending step timer — a fresh PageLoaded is the
      // authoritative "page just settled" signal and resets the wait
      // window for the *current* index (the daemon hasn't yet advanced
      // `currentLinkIndex` if it was interrupted before sending).
      const prior = MutableRef.get(stepFiber)
      if (prior !== null) {
        yield* Fiber.interrupt(prior)
        MutableRef.set(stepFiber, null)
      }
      // Daemon (not child) so the fiber survives this PageLoaded
      // Effect's completion; the bridge dispatcher otherwise tears
      // down child fibers on return.
      const fiber = yield* Effect.forkDaemon(nextStepAction())
      MutableRef.set(stepFiber, fiber)
    })

  const clear = (): void => {
    interruptStepFiber()
    MutableRef.set(currentLinkIndex, 0)
    MutableRef.set(runState, 'running')
    for (const key of MutableHashMap.keys(inProgressResponses)) {
      MutableHashMap.remove(inProgressResponses, key)
    }
  }

  const cancelAllInFlight = (
    send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
  ): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      // Interrupt the pending step timer first so a late `OpenLink`
      // dispatch can't race the host's modal teardown. Then snapshot
      // ids before iterating: `send` is effectful and we'd rather not
      // iterate over a live mutation surface during sequential awaits.
      const fiber = MutableRef.get(stepFiber)
      if (fiber !== null) {
        yield* Fiber.interrupt(fiber)
        MutableRef.set(stepFiber, null)
      }
      const ids = Array.from(MutableHashMap.keys(inProgressResponses))
      for (const id of ids) {
        yield* send({ _tag: 'CancelSnifferRequest', id })
      }
    })

  return {
    inProgressResponses,
    clear,
    cancelAllInFlight,
    ResponseStart,
    ResponseData,
    ResponseFinished,
    RequestError,
    Cancelled,
    PageLoaded,
  }
}

export type { CollectorBridgeMessageHandler, InProgressResponse, OutboundMessage }
export { make, SnifferCancelled }
