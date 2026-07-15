import { type CancelSnifferRequestMessage } from 'browser-sniffer-core'
import { Data, Effect, Either, Encoding, MutableHashMap, Option, type ParseResult } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { UnknownException } from 'effect/Cause'
import type { CollectorBridge } from '../bridge.ts'
import type * as EntityDefinition from '../model/entity-definition.ts'
import { Response, type ScrapingPlan } from '../model/index.ts'
import * as Telemetry from '../telemetry/index.ts'

type Service = MessageHandler.HandlersFor<CollectorBridge['HostToWeb']>

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
 * The response-tracker half of {@link CollectorBridgeMessageHandler}: the
 * five response handlers, the `inProgressResponses` map, and this
 * machine's share of `clear` / `cancelAllInFlight`. It interacts with the
 * step machine only through the supplied `sendMessage` — no shared state.
 */
interface ResponseTracker<TResources> {
  readonly inProgressResponses: MutableHashMap.MutableHashMap<
    string,
    InProgressResponse<TResources>
  >
  readonly ResponseStart: Service['ResponseStart']
  readonly ResponseData: Service['ResponseData']
  readonly ResponseFinished: Service['ResponseFinished']
  readonly RequestError: Service['RequestError']
  readonly Cancelled: Service['Cancelled']
  /**
   * Drop every in-flight tracked response without emitting an
   * `onResult`. The response-tracker's contribution to the composed
   * `clear`.
   */
  readonly clear: () => Effect.Effect<void, never, never>
  /**
   * Dispatch a `CancelSnifferRequest` through `send` for every currently
   * in-flight id. The response-tracker's contribution to the composed
   * `cancelAllInFlight`. Runs each cancel sequentially.
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
  sendMessage: (
    message: typeof CancelSnifferRequestMessage.Type
  ) => Effect.Effect<void, never, never>
  onResult: (args: {
    readonly response: Response.RemoteResponse
    readonly result: Either.Either<
      readonly TResources[],
      ParseResult.ParseError | UnknownException | SnifferCancelled
    >
  }) => void
}): Effect.Effect<ResponseTracker<TResources>, never, never> =>
  Effect.sync(() => {
    const inProgressResponses = MutableHashMap.empty<string, InProgressResponse<TResources>>()

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
          // observation per id; no chunk is appended. Offer the event
          // before dropping the id — same ordering invariant as
          // `ResponseFinished`.
          handleResult({
            response,
            result: Either.left(
              new UnknownException(decoded.left, `Failed to decode base64 response data`)
            ),
          })
          MutableHashMap.remove(inProgressResponses, event.id)
          return
        }
        yield* Effect.sync(() => response.appendChunk(decoded.right))
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
        // `url.path` is a path-only OTel semconv key: strip scheme/host/query
        // from the captured full URL, falling back to the raw string if it
        // doesn't parse as an absolute URL.
        const urlPath = Either.getOrElse(
          Either.try(() => new URL(response.url).pathname),
          () => response.url
        )
        const result = yield* Effect.either(entity.parse(response)).pipe(
          // `Effect.either` always succeeds, so the span closes OK; record the
          // OTel-standard `error.type` (the ParseError tag) only on the Left
          // branch so failures stay queryable without flipping span status.
          Effect.tap((either) =>
            Either.isLeft(either)
              ? Effect.annotateCurrentSpan(
                  Telemetry.Importing.Parse.Span.Attributes.ErrorType,
                  either.left._tag
                )
              : Effect.void
          ),
          Effect.withSpan(Telemetry.Importing.Parse.Span.Name, {
            attributes: {
              [Telemetry.Entity.Attributes.Name]: entity.name,
              [Telemetry.Entity.Attributes.Size]: response.byteLength,
              [Telemetry.Entity.Chunk.Attributes.ChunkCount]: response.chunkCount,
              [Telemetry.Entity.Attributes.UrlPath]: urlPath,
            },
          })
        )
        handleResult({ response, result })
        // Drop the tracked id only *after* `handleResult` has offered the
        // terminal event. The parse above is span-wrapped and latency-bearing;
        // removing the id before it would let a consumer's quiescence check
        // (sniffing done + empty mailbox + no tracked responses) observe a
        // momentary "settled" state mid parse→offer and terminate the run while
        // this write is still pending. Removing after the offer guarantees the
        // consumer always sees either the tracked id or the queued event.
        MutableHashMap.remove(inProgressResponses, event.id)
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
        // Offer the terminal event first, then drop the tracked id — same
        // ordering invariant as `ResponseFinished`: a consumer must never see
        // the id gone before its event is queued.
        handleResult({ response, result: Either.left(new UnknownException(event.message)) })
        MutableHashMap.remove(inProgressResponses, event.id)
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
        // Offer the terminal event first, then drop the tracked id — same
        // ordering invariant as `ResponseFinished`.
        handleResult({
          response,
          result: Either.left(new SnifferCancelled({ id: event.id })),
        })
        MutableHashMap.remove(inProgressResponses, event.id)
      })

    const clear = (): Effect.Effect<void, never, never> =>
      Effect.sync(() => MutableHashMap.clear(inProgressResponses))

    const cancelAllInFlight = (
      send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
    ): Effect.Effect<void, never, never> =>
      Effect.all(
        Array.from(MutableHashMap.keys(inProgressResponses)).map((id) =>
          send({ _tag: 'CancelSnifferRequest', id })
        )
      ).pipe(Effect.asVoid)

    return {
      inProgressResponses,
      ResponseStart,
      ResponseData,
      ResponseFinished,
      RequestError,
      Cancelled,
      clear,
      cancelAllInFlight,
    }
  })

export type { InProgressResponse, ResponseTracker }
export { make, SnifferCancelled }
