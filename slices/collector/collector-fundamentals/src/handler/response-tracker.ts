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

    /**
     * Run `body` with the tracked entry for `id`, or WARN-and-no-op when
     * the id isn't tracked. Shared by every id-addressed handler
     * (`ResponseData` / `ResponseFinished` / `RequestError` / `Cancelled`):
     * a message for an untracked id is always benign — a late or duplicate
     * event for an entry that already reached its terminal, or an
     * unsolicited `Cancelled` ack — so it is logged and dropped, never an
     * error. `handlerName` names the caller in the log line.
     */
    const withTracked = (
      handlerName: string,
      id: string,
      body: (entry: InProgressResponse<TResources>) => Effect.Effect<void, never, never>
    ): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const maybe = MutableHashMap.get(id)(inProgressResponses)
        if (Option.isNone(maybe)) {
          yield* Effect.logWarning(
            `CollectorBridgeMessageHandler.${handlerName}: no tracked response for id ${id}; ignoring`
          )
          return
        }
        yield* body(maybe.value)
      })

    /**
     * Offer the terminal `onResult` for `id`, then drop the tracked entry —
     * in that order. This "offer-then-drop" ordering is the invariant every
     * terminal path (finish, error, cancel, decode-failure) shares; see the
     * [Handler Explanation](../../docs/Handler%20Explanation.md) for why
     * removing the id first would let a consumer's quiescence check observe
     * a momentary "settled" state and end the run mid-write.
     */
    const settleAndRemove = (
      id: string,
      response: Response.RemoteResponse,
      result: Either.Either<
        readonly TResources[],
        ParseResult.ParseError | UnknownException | SnifferCancelled
      >
    ): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        handleResult({ response, result })
        MutableHashMap.remove(inProgressResponses, id)
      })

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
      withTracked('ResponseData', event.id, ({ response }) =>
        Effect.gen(function* () {
          const decoded = Encoding.decodeBase64(event.data)
          if (Either.isLeft(decoded)) {
            // Decode failure on a tracked response routes through the error
            // channel (mirrors `RequestError`) and drops the entry — one
            // terminal observation per id, no chunk appended.
            yield* settleAndRemove(
              event.id,
              response,
              Either.left(
                new UnknownException(decoded.left, `Failed to decode base64 response data`)
              )
            )
            return
          }
          yield* Effect.sync(() => response.appendChunk(decoded.right))
        })
      )

    const ResponseFinished: Service['ResponseFinished'] = (event) =>
      withTracked('ResponseFinished', event.id, ({ response, entity }) =>
        Effect.gen(function* () {
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
          // The parse is span-wrapped and latency-bearing, so the offer-then-drop
          // ordering matters most here (see `settleAndRemove`).
          yield* settleAndRemove(event.id, response, result)
        })
      )

    const RequestError: Service['RequestError'] = (event) =>
      // `event.url` is intentionally ignored — the URL captured at
      // `ResponseStart` is the routing source of truth and the entity is
      // already pinned there, so a redirected `event.url` is not
      // load-bearing (the start URL stays on `response.url` for the
      // consumer). See the [Handler Explanation](../../docs/Handler%20Explanation.md).
      withTracked('RequestError', event.id, ({ response }) =>
        settleAndRemove(event.id, response, Either.left(new UnknownException(event.message)))
      )

    const Cancelled: Service['Cancelled'] = (event) =>
      withTracked('Cancelled', event.id, ({ response }) =>
        settleAndRemove(event.id, response, Either.left(new SnifferCancelled({ id: event.id })))
      )

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
