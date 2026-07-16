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
 * (via the injected `publishSniffResult` / `endRequestSniffingResultsUnlessMoreExpected`)
 * and exposes the hooks the lifecycle needs to drive the run's end-paths. It
 * interacts with the automatic-navigation machine only through the supplied `sendMessage` — no
 * shared state.
 */
interface SnifferResponseTracker<TResources> {
  readonly incompleteSniffedRequests: MutableHashMap.MutableHashMap<
    string,
    IncompleteSniffedRequest<TResources>
  >
  readonly ResponseStart: Service['ResponseStart']
  readonly ResponseData: Service['ResponseData']
  readonly ResponseFinished: Service['ResponseFinished']
  readonly RequestError: Service['RequestError']
  readonly Cancelled: Service['Cancelled']
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
  publishSniffResult,
  endRequestSniffingResultsUnlessMoreExpected,
}: {
  matchEntity: (url: string) => Option.Option<EntityDefinition.EntityDefinition<TResources>>
  sendMessage: (
    message: typeof CancelSnifferRequestMessage.Type
  ) => Effect.Effect<void, never, never>
  /**
   * Publish one settled {@link SniffResult} onto the {@link RunLifecycleState}'s
   * stream — synchronous, so `offerSniffResultAndUntrack` keeps its
   * offer-then-drop order.
   */
  publishSniffResult: (result: SniffResult<TResources>) => void
  /**
   * Run after each settle: the lifecycle closes its results stream iff sniffing
   * is complete and no sniffed request is still incomplete. Chained after every
   * publish + drop.
   */
  endRequestSniffingResultsUnlessMoreExpected: Effect.Effect<void, never, never>
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
     * Publish the settled {@link SniffResult} for `id`, then drop the tracked
     * entry — in that order. `publishSniffResult` is synchronous, so this
     * preserves the "offer-then-drop" invariant every terminal path (finish,
     * error, cancel, decode-failure) shares; see the [Handler
     * Explanation](../../docs/Handler%20Explanation.md) for why removing the id
     * first would let `endRequestSniffingResultsUnlessMoreExpected` observe a
     * momentary "settled" state and close the stream mid-write. The response URL
     * is folded into the failure `Left` here, where the `RemoteResponse` is in
     * hand. Dropping the last incomplete request after sniffing completes is what
     * closes the stream, so the offer-then-drop order also guarantees the final
     * result is queued before the stream closes.
     */
    const offerSniffResultAndUntrack = (
      id: string,
      response: Response.RemoteResponse,
      result: Either.Either<
        readonly TResources[],
        ParseResult.ParseError | UnknownException | SnifferCancelled
      >
    ): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        publishSniffResult(Either.mapLeft(result, (error) => ({ error, url: response.url })))
        MutableHashMap.remove(incompleteSniffedRequests, id)
      }).pipe(Effect.andThen(endRequestSniffingResultsUnlessMoreExpected))

    const ResponseStart: Service['ResponseStart'] = (event) => {
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

    const ResponseData: Service['ResponseData'] = (event) =>
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
          // ordering matters most here (see `offerSniffResultAndUntrack`).
          yield* offerSniffResultAndUntrack(event.id, response, result)
        })
      )

    const RequestError: Service['RequestError'] = (event) =>
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

    const Cancelled: Service['Cancelled'] = (event) =>
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
          publishSniffResult(
            Either.left({
              error: new UnknownException(
                `response for ${response.url} still in-flight at idle timeout; abandoning`
              ),
              url: response.url,
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
      ResponseStart,
      ResponseData,
      ResponseFinished,
      RequestError,
      Cancelled,
      hasIncompleteSniffedRequests,
      failIncompleteSniffedRequests,
      cancelIncompleteSniffedRequests,
    }
  })

export type { IncompleteSniffedRequest, SnifferResponseTracker, SniffFailure, SniffResult }
export { make, SnifferCancelled }
