import { type CancelSnifferRequestMessage } from 'browser-sniffer-core'
import {
  Cause,
  Data,
  DateTime,
  Effect,
  Either,
  Encoding,
  MutableHashMap,
  Option,
  type ParseResult,
} from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { UnknownException } from 'effect/Cause'
import { type HttpMethod, isHttpMethod } from 'http-extraction-fundamentals'
import type { CollectorBridge } from '../bridge.ts'
import type * as CollectorHttpResponseKind from '../model/collector-http-response-kind.ts'
import { CollectorHttpResponse } from '../model/index.ts'
import type * as Step from '../model/step.ts'
import * as Telemetry from '../telemetry/index.ts'
import type { RunRecorder } from './run-recorder.ts'

type Service = MessageHandler.HandlersFor<CollectorBridge['HostToWeb']>

/**
 * Per-id state for one incomplete sniffed request — a tracked response still
 * accumulating body chunks. `responseKind` is pinned at `ResponseStart` so
 * `ResponseFinished` / `RequestError` don't re-walk `responseKinds` (and so
 * a hypothetical mutation of the remote between Start and Finish couldn't
 * reroute parsing — the factory now deep-freezes anyway, but this nails the
 * invariant).
 */
interface IncompleteSniffedRequest<TParsed> {
  readonly response: CollectorHttpResponse
  readonly responseKind: CollectorHttpResponseKind.CollectorHttpResponseKind<TParsed>
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
   * `true` only for a request settled by the abandon path
   * (`failIncompleteSniffedRequests`), which force-closes the results stream
   * itself — the signal for `handleNewSniffResult` to skip its per-result
   * stream-close check. A normal terminal (including a `Cancelled` event) is
   * `false`.
   */
  readonly abandoned: boolean
}

/**
 * A settled request's decoded output, split by what the run owes the caller
 * for it. `resources` is the primary output — the runner persists it and
 * reports its write failures. `diagnostics` are records *about* the run (a
 * provenance trace, say) minted by the plan's `captureProvenance` hook; the
 * runner persists them best-effort and a failed diagnostic write never reaches
 * the run's summary. The split is structural — decided where the batch is
 * built — so no downstream consumer re-derives it from resource shapes.
 */
interface SniffedBatch<TParsed> {
  readonly resources: readonly TParsed[]
  readonly diagnostics: readonly TParsed[]
}

/**
 * One settled outcome for a sniffed request, the element type of the run's
 * `requestSniffingResults` stream: `Right` a decoded {@link SniffedBatch},
 * `Left` a {@link SniffFailure}. The tracker folds the response URL into the
 * `Left` at emit time (it holds the `CollectorHttpResponse`), so consumers get
 * everything they need without the full response object — the runner reads
 * only the URL.
 */
type SniffResult<TParsed> = Either.Either<SniffedBatch<TParsed>, SniffFailure>

/**
 * The response-tracker half of {@link CollectorBridgeMessageHandler}: the five
 * response handlers and the `incompleteSniffedRequests` map. It publishes each
 * settled request's {@link SniffResult} to the {@link RunLifecycleState}'s stream
 * (via the injected `handleNewSniffResult`, which both offers the result and runs
 * the lifecycle's stream-close check) and exposes the hooks the lifecycle needs
 * to drive the run's end-paths. It reaches the automatic-navigation machine only
 * through the supplied `sendMessage` and the injected `handleGeneratedSteps`
 * hook (a successful parse's `followUpSteps`) — no shared state.
 */
interface SnifferResponseTracker<TParsed> {
  readonly incompleteSniffedRequests: MutableHashMap.MutableHashMap<
    string,
    IncompleteSniffedRequest<TParsed>
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
   * this). Backs that force-close escape.
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

const make = <TParsed>({
  matchResponseKind,
  sendMessage,
  handleNewSniffResult,
  handleGeneratedSteps,
  captureProvenance,
  recorder,
}: {
  matchResponseKind: (
    url: string,
    method: Option.Option<HttpMethod>
  ) => Option.Option<CollectorHttpResponseKind.CollectorHttpResponseKind<TParsed>>
  sendMessage: (
    message: typeof CancelSnifferRequestMessage.Type
  ) => Effect.Effect<void, never, never>
  /**
   * The plan's provenance hook with the run id already applied (the
   * composition owns the id; the tracker stays plan-decoupled). Invoked only
   * for a parse that succeeded with a non-empty batch — the one moment the
   * "this response → these resources" pairing exists. The tracker enforces
   * every rule that keeps it a diagnostic: a failing or dying hook is
   * WARN-logged and the parse output flows on unchanged.
   */
  captureProvenance?: (
    response: CollectorHttpResponse,
    produced: readonly TParsed[]
  ) => Effect.Effect<SniffedBatch<TParsed>, unknown>
  /**
   * Run-scoped recorder that captures every settled response (minus omitted
   * content types) as an `Extraction.Input`. Invoked at every settle point
   * (`ResponseFinished` / `RequestError`) before the parse runs, so a parse
   * failure does not drop the record. Omitted when the runner does not need a
   * recording (the recorder is a run property, not a plan property).
   */
  recorder?: RunRecorder
  /**
   * Publish one settled {@link SniffResult} onto the {@link RunLifecycleState}'s
   * stream. Offers the result, then runs the lifecycle's stream-close check —
   * so `offerSniffResultAndUntrack` drops the tracked id *before* calling this,
   * letting that check see the settled request already gone from the map.
   */
  handleNewSniffResult: (result: SniffResult<TParsed>) => Effect.Effect<void, never, never>
  /**
   * Feed the steps a successfully-parsed entity's `followUpSteps` produced to
   * the automatic-navigation queue (the composition dedups/caps them first).
   * Called **before** the drop-then-offer in {@link offerSniffResultAndUntrack},
   * extending that invariant to **generate → drop → offer**: the machine sees
   * the generated steps (leaving `Drained` if it was idle) before the offer's
   * close-check can inject `NoMoreResultsExpected`, so it can never observe "no
   * more results" before the steps this settle produced.
   */
  handleGeneratedSteps: (steps: readonly Step.Step[]) => Effect.Effect<void, never, never>
}): Effect.Effect<SnifferResponseTracker<TParsed>, never, never> =>
  // No effectful setup — the tracker holds only a mutable map and closes over
  // the injected lifecycle seams — so this is a plain `Effect.sync`, not a
  // generator. The results stream and completion latch live on the `RunLifecycleState`.
  Effect.sync(() => {
    const incompleteSniffedRequests = MutableHashMap.empty<
      string,
      IncompleteSniffedRequest<TParsed>
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
      body: (entry: IncompleteSniffedRequest<TParsed>) => Effect.Effect<void, never, never>
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
     * folded into the failure `Left` here, where the `CollectorHttpResponse` is in hand.
     *
     * `handleNewSniffResult` is passed to `Effect.andThen` as a *thunk* so it is
     * evaluated only after the `remove` runs — its synchronous `unsafeOffer`
     * must not fire eagerly (i.e. before the remove) at expression-build time.
     */
    const offerSniffResultAndUntrack = (
      id: string,
      response: CollectorHttpResponse,
      result: Either.Either<
        SniffedBatch<TParsed>,
        ParseResult.ParseError | UnknownException | SnifferCancelled
      >
    ): Effect.Effect<void, never, never> =>
      Effect.andThen(
        Effect.sync(() => {
          MutableHashMap.remove(incompleteSniffedRequests, id)
        }),
        () =>
          handleNewSniffResult(
            Either.mapLeft(result, (error) => ({ error, url: response.url, abandoned: false }))
          )
      )

    const handleResponseStart: Service['ResponseStart'] = (event) =>
      Effect.gen(function* () {
        // Normalize the wire method to the closed `HttpMethod` union at the
        // one boundary that carries the wire value in. An unrecognized value
        // reads as `Option.none()` — a matcher's `verb` list is closed, so
        // an unknown method never claims a kind.
        const method: Option.Option<HttpMethod> = isHttpMethod(event.method)
          ? Option.some(event.method)
          : Option.none()
        const responseKind = matchResponseKind(event.url, method)
        if (Option.isNone(responseKind)) {
          yield* sendMessage({
            _tag: 'CancelSnifferRequest',
            id: event.id,
          } satisfies typeof CancelSnifferRequestMessage.Type)
          return
        }
        // Read here rather than at settle: this is the instant the response
        // *started*, the only one the sniffer reports, and a capturing entity
        // that timestamps an exchange must not label the settle as the start.
        const startedAt = yield* DateTime.now
        MutableHashMap.set(event.id, {
          response: new CollectorHttpResponse(
            event.id,
            event.url,
            method,
            event.status,
            event.statusText,
            event.headers,
            startedAt
          ),
          responseKind: responseKind.value,
        })(incompleteSniffedRequests)
      })

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
      withTracked('ResponseFinished', event.id, ({ response, responseKind }) =>
        Effect.gen(function* () {
          recorder?.record(response)
          // `url.path` is a path-only OTel semconv key: strip scheme/host/query
          // from the captured full URL, falling back to the raw string if it
          // doesn't parse as an absolute URL.
          const urlPath = Either.getOrElse(
            Either.try(() => new URL(response.url).pathname),
            () => response.url
          )
          const result = yield* Effect.either(responseKind.parse(response)).pipe(
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
                [Telemetry.Entity.Attributes.Name]: responseKind.name,
                [Telemetry.Entity.Attributes.Size]: response.byteLength,
                [Telemetry.Entity.Chunk.Attributes.ChunkCount]: response.chunkCount,
                [Telemetry.Entity.Attributes.UrlPath]: urlPath,
              },
            })
          )
          // Generate → drop → offer: a successful parse's `followUpSteps` are
          // fed to the queue *before* the settle is dropped and offered, so the
          // automatic-navigation machine leaves `Drained` (if idle) ahead of the
          // offer's `NoMoreResultsExpected` close-check. Failed parses,
          // `RequestError`, `Cancelled`, and abandons generate nothing.
          if (Either.isRight(result) && responseKind.followUpSteps !== undefined) {
            const parsed = result.right
            // Bind the pure, this-free method so the thunk can call it.
            // oxlint-disable-next-line typescript-eslint/unbound-method -- pure, this-free method; the call is safe
            const generateFollowUps = responseKind.followUpSteps
            // A generator running on malformed scraped data can throw; contain it
            // like `parse`'s `Effect.either` above so a throw WARNs and generates
            // nothing but still reaches the drop-then-offer below — skipping it
            // would strand this id and hang the run (see Handler Explanation).
            yield* Effect.try(() => generateFollowUps(parsed, response)).pipe(
              Effect.flatMap(handleGeneratedSteps),
              Effect.catchAll((error) =>
                Effect.logWarning(
                  `CollectorBridgeMessageHandler.ResponseFinished: ${responseKind.name}.followUpSteps threw; generating no follow-ups (${error.message})`
                )
              )
            )
          }
          // Capture provenance *after* generation (the hook must never change
          // what `followUpSteps` sees) and *before* the drop-then-offer. The
          // rules that keep the hook a diagnostic are enforced here, once, for
          // every plan: a failed parse was never captured (this branch is
          // Right-only), an empty parse is never captured — that rule is the
          // line between deliberate provenance collection and bulk recording —
          // and a failing or *dying* hook is WARN-logged and the parse output
          // flows on unchanged, so a diagnostic can never take a run down.
          // `Effect.suspend` turns a synchronously-throwing hook into a caught
          // defect rather than an escape from this pipeline.
          const settled = Either.isLeft(result)
            ? Either.left(result.left)
            : Either.right(
                yield* result.right.length === 0 || captureProvenance === undefined
                  ? Effect.succeed<SniffedBatch<TParsed>>({
                      resources: result.right,
                      diagnostics: [],
                    })
                  : Effect.suspend(() => captureProvenance(response, result.right)).pipe(
                      Effect.catchAllCause((cause) =>
                        Effect.as(
                          Effect.logWarning(
                            `CollectorBridgeMessageHandler.ResponseFinished: capturing provenance for ${response.url} failed; keeping the parsed resources (${Cause.pretty(cause)})`
                          ),
                          { resources: result.right, diagnostics: [] }
                        )
                      )
                    )
              )
          // The parse is span-wrapped and latency-bearing, so the drop-then-offer
          // ordering matters most here (see `offerSniffResultAndUntrack`).
          yield* offerSniffResultAndUntrack(event.id, response, settled)
        })
      )

    const handleRequestError: Service['RequestError'] = (event) =>
      // `event.url` is intentionally ignored — the URL captured at
      // `ResponseStart` is the routing source of truth and the entity is
      // already pinned there, so a redirected `event.url` is not
      // load-bearing (the start URL stays on `response.url` for the
      // consumer). See the [Handler Explanation](../../docs/Handler%20Explanation.md).
      withTracked('RequestError', event.id, ({ response }) =>
        Effect.gen(function* () {
          recorder?.record(response)
          yield* offerSniffResultAndUntrack(
            event.id,
            response,
            Either.left(new UnknownException(event.message))
          )
        })
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
            `CollectorBridgeMessageHandler: abandoning with ${incomplete.length} response(s) still in-flight; settling as failures`
          )
        }
        // Run each publish (don't just call it): `handleNewSniffResult` returns
        // an `Effect`, so a bare call in a loop that discarded it would rely on
        // its offer being a synchronous side effect — a coupling a future refactor
        // could silently break, dropping every abandoned failure.
        yield* Effect.forEach(
          incomplete,
          ({ response }) =>
            handleNewSniffResult(
              Either.left({
                error: new UnknownException(
                  `response for ${response.url} still in-flight at abandon; abandoning`
                ),
                url: response.url,
                abandoned: true,
              })
            ),
          { discard: true }
        )
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

export type {
  IncompleteSniffedRequest,
  SniffedBatch,
  SnifferResponseTracker,
  SniffFailure,
  SniffResult,
}
export { make, SnifferCancelled }
