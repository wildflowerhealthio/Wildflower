import { type CancelSnifferRequestMessage } from 'browser-sniffer-core'
import { Data, Effect, Either, Encoding, MutableHashMap, Option, type ParseResult } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { UnknownException } from 'effect/Cause'
import type { CollectorBridge } from '../bridge.ts'
import type * as EntityDefinition from '../model/entity-definition.ts'
import { Response } from '../model/index.ts'
import * as Telemetry from '../telemetry/index.ts'

type Service = MessageHandler.HandlersFor<CollectorBridge['HostToWeb']>

/**
 * Per-id state for one incomplete sniffed request — a tracked response still
 * accumulating body chunks. `entity` is pinned at `ResponseStart` so
 * `ResponseFinished` / `RequestError` don't re-walk `entityDefinitions` (and so
 * a hypothetical mutation of the remote between Start and Finish couldn't
 * reroute parsing — the factory now deep-freezes anyway, but this nails the
 * invariant).
 */
interface IncompleteSniffedRequest<TResources> {
  readonly response: Response.RemoteResponse
  readonly entity: EntityDefinition.EntityDefinition<TResources>
}

/**
 * Terminal-error tag emitted on the {@link SniffResult} stream when the page
 * acknowledges a `CancelSnifferRequest` mid-stream with a `Cancelled` event.
 * Carries the sniffer request id for downstream correlation.
 */
class SnifferCancelled extends Data.TaggedError('SnifferCancelled')<{
  readonly id: string
}> {}

/**
 * A sniff-level parse/transport failure, keyed on the response URL captured at
 * `ResponseStart`. The `Left` of a {@link SniffResult}; distinct from a
 * resource's *write* failure (which the persist sink reports downstream).
 */
type SniffFailure = {
  readonly error: ParseResult.ParseError | UnknownException | SnifferCancelled
  readonly url: string
  /**
   * `true` only for a request settled by the idle-timeout abandon path
   * (`failIncompleteSniffedRequests`), which force-closes the results stream
   * itself — the signal for `handleNewSniffResult` to skip its per-result
   * stream-close check. A normal terminal (including a `Cancelled` event) is
   * `false`.
   */
  readonly abandoned: boolean
}

/**
 * One settled outcome for a sniffed request, the element type of the run's
 * `requestSniffingResults` stream: `Right` a decoded resource batch, `Left` a
 * {@link SniffFailure}. The tracker folds the response URL into the `Left` at
 * emit time (it holds the `RemoteResponse`), so consumers get everything they
 * need without the full response object — the runner reads only the URL.
 */
type SniffResult<TResources> = Either.Either<readonly TResources[], SniffFailure>

/**
 * The response-tracker half of {@link CollectorBridgeMessageHandler}: the five
 * response handlers and the `incompleteSniffedRequests` map. It publishes each
 * settled request's {@link SniffResult} to the {@link RunLifecycleState}'s stream
 * (via the injected `handleNewSniffResult`, which both offers the result and runs
 * the lifecycle's stream-close check) and exposes the hooks the lifecycle needs
 * to drive the run's end-paths. It
 * interacts with the automatic-navigation machine only through the supplied `sendMessage` — no
 * shared state.
 */
interface SnifferResponseTracker<TResources> {
  readonly incompleteSniffedRequests: MutableHashMap.MutableHashMap<
    string,
    IncompleteSniffedRequest<TResources>
  >
  readonly handleResponseStart: Service['ResponseStart']
  readonly handleResponseData: Service['ResponseData']
  readonly handleResponseFinished: Service['ResponseFinished']
  readonly handleRequestError: Service['RequestError']
  readonly handleCancelled: Service['Cancelled']
  /**
   * Whether any sniffed request is still incomplete — a synchronous
   * `MutableHashMap.size` read. The {@link RunLifecycleState} reads this as one of the
   * two gates for closing the results stream (the map is the single source of
   * truth; the lifecycle keeps no shadow counter).
   */
  readonly hasIncompleteSniffedRequests: () => boolean
  /**
   * Publish every still-incomplete sniffed request as a `Left` failure onto the
   * lifecycle's stream (a stalled download whose `ResponseData` chunks never
   * produced a terminal), then drop them. Does **not** close the stream — the
   * lifecycle owns that (`abandonAllRequestSniffing` chains the close after
   * this). Backs the idle-timeout escape.
   */
  readonly failIncompleteSniffedRequests: Effect.Effect<void, never, never>
  /**
   * Ask the host to `CancelSnifferRequest` every still-incomplete sniffed
   * request (so the page stops streaming bytes), then drop them — publishing no
   * result. The response-tracker's contribution to the lifecycle's
   * `cancelAllRequestSniffing`. Sends each cancel sequentially, then clears the
   * map (send reads the ids before the drop empties it).
   */
  readonly cancelIncompleteSniffedRequests: (
    send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
  ) => Effect.Effect<void, never, never>
}

const make = <TResources>({
  matchEntity,
  sendMessage,
  handleNewSniffResult,
}: {
  matchEntity: (url: string) => Option.Option<EntityDefinition.EntityDefinition<TResources>>
  sendMessage: (
    message: typeof CancelSnifferRequestMessage.Type
  ) => Effect.Effect<void, never, never>
  /**
   * Publish one settled {@link SniffResult} onto the {@link RunLifecycleState}'s
   * stream. Offers the result, then runs the lifecycle's stream-close check —
   * so `offerSniffResultAndUntrack` drops the tracked id *before* calling this,
   * letting that check see the settled request already gone from the map.
   */
  handleNewSniffResult: (result: SniffResult<TResources>) => Effect.Effect<void, never, never>
}): Effect.Effect<SnifferResponseTracker<TResources>, never, never> =>
  // No effectful setup — the tracker holds only a mutable map and closes over
  // the injected lifecycle seams — so this is a plain `Effect.sync`, not a
  // generator. The results stream and completion latch live on the `RunLifecycleState`.
  Effect.sync(() => {
    const incompleteSniffedRequests = MutableHashMap.empty<
      string,
      IncompleteSniffedRequest<TResources>
    >()

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
      body: (entry: IncompleteSniffedRequest<TResources>) => Effect.Effect<void, never, never>
    ): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const maybe = MutableHashMap.get(id)(incompleteSniffedRequests)
        if (Option.isNone(maybe)) {
          yield* Effect.logWarning(
            `CollectorBridgeMessageHandler.${handlerName}: no tracked response for id ${id}; ignoring`
          )
          return
        }
        yield* body(maybe.value)
      })

    /**
     * Drop the tracked entry for `id`, then publish its settled
     * {@link SniffResult} — in that order. The injected `handleNewSniffResult`
     * (the {@link RunLifecycleState} seam) both offers the result onto the stream
     * *and* runs the end-check, and it offers before it checks.
     * So dropping the id first is what lets that end-check see the map without
     * this request and close the stream once the last one settles — while the
     * result is still queued ahead of the close. (Publishing first would leave
     * the just-settled id in the map at end-check time, so the final settle could
     * never close the stream; see the [Handler
     * Explanation](../../docs/Handler%20Explanation.md).) The response URL is
     * folded into the failure `Left` here, where the `RemoteResponse` is in hand.
     */
    const offerSniffResultAndUntrack = (
      id: string,
      response: Response.RemoteResponse,
      result: Either.Either<
        readonly TResources[],
        ParseResult.ParseError | UnknownException | SnifferCancelled
      >
    ): Effect.Effect<void, never, never> =>
      Effect.andThen(
        Effect.sync(() => {
          MutableHashMap.remove(incompleteSniffedRequests, id)
        }),
        handleNewSniffResult(
          Either.mapLeft(result, (error) => ({ error, url: response.url, abandoned: false }))
        )
      )

    const handleResponseStart: Service['ResponseStart'] = (event) => {
      const entity = matchEntity(event.url)
      if (Option.isNone(entity)) {
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
        entity: entity.value,
      })(incompleteSniffedRequests)
      return Effect.void
    }

    const handleResponseData: Service['ResponseData'] = (event) =>
      withTracked('ResponseData', event.id, ({ response }) =>
        Effect.gen(function* () {
          const decoded = Encoding.decodeBase64(event.data)
          if (Either.isLeft(decoded)) {
            // Decode failure on a tracked response routes through the error
            // channel (mirrors `RequestError`) and drops the entry — one
            // terminal observation per id, no chunk appended.
            yield* offerSniffResultAndUntrack(
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

    const handleResponseFinished: Service['ResponseFinished'] = (event) =>
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
          // The parse is span-wrapped and latency-bearing, so the drop-then-offer
          // ordering matters most here (see `offerSniffResultAndUntrack`).
          yield* offerSniffResultAndUntrack(event.id, response, result)
        })
      )

    const handleRequestError: Service['RequestError'] = (event) =>
      // `event.url` is intentionally ignored — the URL captured at
      // `ResponseStart` is the routing source of truth and the entity is
      // already pinned there, so a redirected `event.url` is not
      // load-bearing (the start URL stays on `response.url` for the
      // consumer). See the [Handler Explanation](../../docs/Handler%20Explanation.md).
      withTracked('RequestError', event.id, ({ response }) =>
        offerSniffResultAndUntrack(
          event.id,
          response,
          Either.left(new UnknownException(event.message))
        )
      )

    const handleCancelled: Service['Cancelled'] = (event) =>
      withTracked('Cancelled', event.id, ({ response }) =>
        offerSniffResultAndUntrack(
          event.id,
          response,
          Either.left(new SnifferCancelled({ id: event.id }))
        )
      )

    const hasIncompleteSniffedRequests = (): boolean =>
      MutableHashMap.size(incompleteSniffedRequests) > 0

    const failIncompleteSniffedRequests: Effect.Effect<void, never, never> = Effect.gen(
      function* () {
        const incomplete = Array.from(MutableHashMap.values(incompleteSniffedRequests))
        if (incomplete.length > 0) {
          yield* Effect.logWarning(
            `CollectorBridgeMessageHandler: idle timeout with ${incomplete.length} response(s) still in-flight; settling as failures`
          )
        }
        for (const { response } of incomplete) {
          handleNewSniffResult(
            Either.left({
              error: new UnknownException(
                `response for ${response.url} still in-flight at idle timeout; abandoning`
              ),
              url: response.url,
              abandoned: true,
            })
          )
        }
        MutableHashMap.clear(incompleteSniffedRequests)
      }
    )

    const cancelIncompleteSniffedRequests = (
      send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
    ): Effect.Effect<void, never, never> =>
      // Send each cancel first (reads the ids), then drop the map. The order is
      // load-bearing: clearing first would leave nothing to cancel.
      Effect.all(
        Array.from(MutableHashMap.keys(incompleteSniffedRequests)).map((id) =>
          send({ _tag: 'CancelSnifferRequest', id })
        )
      ).pipe(Effect.andThen(Effect.sync(() => MutableHashMap.clear(incompleteSniffedRequests))))

    return {
      incompleteSniffedRequests,
      handleResponseStart,
      handleResponseData,
      handleResponseFinished,
      handleRequestError,
      handleCancelled,
      hasIncompleteSniffedRequests,
      failIncompleteSniffedRequests,
      cancelIncompleteSniffedRequests,
    }
  })

export type { IncompleteSniffedRequest, SnifferResponseTracker, SniffFailure, SniffResult }
export { make, SnifferCancelled }
