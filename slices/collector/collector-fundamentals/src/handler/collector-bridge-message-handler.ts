import { type CancelSnifferRequestMessage } from 'browser-sniffer-core'
import { type EntityDefinition, type RemoteKind, Response } from 'collector-fundamentals/model'
import { Either, type ParseResult, Effect, Encoding, MutableHashMap, Option, Data } from 'effect'
import { UnknownException } from 'effect/Cause'
import type CollectorBridge from '../bridge.ts'

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

interface CollectorBridgeMessageHandler<TResources> extends Service {
  readonly inProgressResponses: MutableHashMap.MutableHashMap<
    string,
    InProgressResponse<TResources>
  >
  /**
   * Drop every in-flight tracked response without emitting an
   * `onResult`. Use from a screen-unmount / sync-abandoned path to
   * release buffered chunks — the host alone knows when the sniffer
   * is permanently silent for a session, so the handler can't time
   * entries out on its own.
   */
  readonly clear: () => void
}

const make = <TResources>({
  remote,
  sendMessage,
  onResult: handleResult,
}: {
  remote: RemoteKind.RemoteKind<TResources>
  sendMessage: (
    message: typeof CancelSnifferRequestMessage.Type
  ) => Effect.Effect<void, never, never>
  onResult: (args: {
    readonly response: Response.RemoteResponse
    readonly result: Either.Either<
      EntityDefinition.Parsed<TResources>,
      ParseResult.ParseError | UnknownException | SnifferCancelled
    >
  }) => void
}): CollectorBridgeMessageHandler<TResources> => {
  const inProgressResponses = MutableHashMap.empty<string, InProgressResponse<TResources>>()

  const ResponseStart: Service['ResponseStart'] = (event) => {
    const entity = remote.entityDefinitions.find((e) => e.isFoundAt(event.url))
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

  const clear = (): void => {
    for (const key of MutableHashMap.keys(inProgressResponses)) {
      MutableHashMap.remove(inProgressResponses, key)
    }
  }

  return {
    inProgressResponses,
    clear,
    ResponseStart,
    ResponseData,
    ResponseFinished,
    RequestError,
    Cancelled,
  }
}

export type { CollectorBridgeMessageHandler, InProgressResponse }
export { make, SnifferCancelled }
