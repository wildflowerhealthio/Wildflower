import { type CancelSnifferRequestMessage, type ClickMessage } from 'browser-sniffer-core'
import {
  Data,
  Duration,
  Effect,
  Either,
  Encoding,
  Fiber,
  MutableHashMap,
  SynchronizedRef,
  Option,
  type ParseResult,
  Match,
} from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { UnknownException } from 'effect/Cause'
import type { RuntimeFiber } from 'effect/Fiber'
import type {
  CollectorBridge,
  OpenMessage,
  SniffingComplete as SniffingCompleteMessage,
} from '../bridge.ts'
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

/**
 * Step-driver finite state machine. Each variant carries exactly the
 * data needed for that state — no shared optional fields, no
 * sentinels for "running but no timer yet".
 *
 * Transitions:
 *   AwaitingPageLoaded(n)   ─PageLoaded→ TimerPending(n, fiber)
 *   TimerPending(d, f)      ─PageLoaded→ TimerPending(d, fiber')   (f interrupted; fresh fiber)
 *   TimerPending(d, _)      ─timer fires, `d < N` → AwaitingPageLoaded(d + 1)
 *   TimerPending(N, _)      ─timer fires, `d ≡ N` → Done
 *   Done                    ─PageLoaded→ Done (WARN-log)
 *   any                     ─clear()→ AwaitingPageLoaded(0)
 *   any                     ─cancelAllInFlight→ AwaitingPageLoaded(d) (d preserved)
 *
 * All transitions go through `SynchronizedRef.update*Effect`, which
 * serializes reads and writes through a semaphore — no interleaving
 * is possible. The timer fiber additionally checks the cell's
 * `TimerPending.fiber` against the fiber it scheduled itself as; if
 * another transition (`PageLoaded` re-arm, `clear`,
 * `cancelAllInFlight`) has swapped a different record in, the
 * commit no-ops and the replacement state survives.
 */
type StepState =
  | { readonly _tag: 'AwaitingPageLoaded'; readonly nextIndex: number }
  | {
      readonly _tag: 'TimerPending'
      readonly dispatchIndex: number
      readonly fiber: Fiber.RuntimeFiber<void, never>
    }
  | { readonly _tag: 'Done' }

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
}): Effect.Effect<CollectorBridgeMessageHandler<TResources>, never, never> =>
  Effect.gen(function* () {
    const inProgressResponses = MutableHashMap.empty<string, InProgressResponse<TResources>>()
    const stepStateRef = yield* SynchronizedRef.make<StepState>({
      _tag: 'AwaitingPageLoaded',
      nextIndex: 0,
    })

    /**
     * Schedule a fresh timer for `dispatchIndex` and return the
     * `TimerPending` record naming it. The forked daemon:
     *   1. Sleeps for `stepDelay` (interruptible).
     *   2. Inside an `Effect.uninterruptible` block, takes the
     *      synchronized lock on `stepStateRef`. If the cell still
     *      holds *this* record (same `_tag`, `dispatchIndex`, and
     *      `fiber` reference), dispatches the indexed link — or
     *      `SniffingComplete` when `dispatchIndex === linkSequence.length` —
     *      and transitions to the post-dispatch state. Otherwise no-ops.
     *
     * The fiber-identity check is the discriminator: any interleaved
     * transition (`PageLoaded` re-arm, `clear`, `cancelAllInFlight`)
     * installs a record naming a different (or no) fiber, so this
     * daemon's commit sees a stale view, no-ops, and the replacement
     * survives.
     *
     * Caller responsibility: interrupt any prior `TimerPending` fiber
     * before calling `scheduleTimer`. Orphan fibers from skipped
     * interrupts still die safely (the identity check fails), but
     * waste a `stepDelay`-length sleep.
     */
    const scheduleTimer = (dispatchIndex: number): Effect.Effect<StepState, never, never> =>
      Effect.gen(function* () {
        const fiber: RuntimeFiber<void, never> = yield* Effect.forkDaemon(
          Effect.gen(function* () {
            yield* Effect.sleep(scrapingPlan.stepDelay).pipe(
              Effect.withSpan(Telemetry.Sniffing.Wait.Span.Name, {
                attributes: {
                  [Telemetry.Sniffing.Attributes.StepIndex]: dispatchIndex,
                  [Telemetry.Sniffing.Attributes.StepDelayMs]: Duration.toMillis(
                    scrapingPlan.stepDelay
                  ),
                },
              })
            )
            yield* Effect.uninterruptible(
              SynchronizedRef.getAndUpdateEffect(stepStateRef, (stepState) =>
                Effect.gen(function* () {
                  if (
                    stepState._tag !== 'TimerPending' ||
                    stepState.dispatchIndex !== dispatchIndex ||
                    stepState.fiber !== fiber
                  ) {
                    return stepState
                  }
                  if (dispatchIndex < scrapingPlan.linkSequence.length) {
                    // `Link.Open` / `Link.Click` are structurally identical
                    // to the `Open` / `Click` bridge messages — forward
                    // verbatim.
                    const link = scrapingPlan.linkSequence[dispatchIndex]
                    yield* sendMessage(link).pipe(
                      Effect.withSpan(Telemetry.Sniffing.Dispatch.Span.Name, {
                        attributes: {
                          [Telemetry.Sniffing.Attributes.StepIndex]: dispatchIndex,
                          [Telemetry.Sniffing.Attributes.LinkKind]: link._tag,
                        },
                      })
                    )
                    return {
                      _tag: 'AwaitingPageLoaded',
                      nextIndex: dispatchIndex + 1,
                    } as const
                  } else {
                    yield* sendMessage({ _tag: 'SniffingComplete' }).pipe(
                      Effect.withSpan(Telemetry.Sniffing.Dispatch.Span.Name, {
                        attributes: {
                          [Telemetry.Sniffing.Attributes.StepIndex]: dispatchIndex,
                          [Telemetry.Sniffing.Attributes.LinkKind]: 'SniffingComplete',
                        },
                      })
                    )
                    return { _tag: 'Done' } as const
                  }
                })
              )
            )
          })
        )
        return {
          _tag: 'TimerPending',
          dispatchIndex,
          fiber,
        } as const
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
          // TEMP debug: when the entity parse fails, dump the URL, the
          // captured content-type, and the first 200 bytes of the body so
          // we can tell whether the sniffer captured an unexpected HTML
          // envelope (viewer wrapper drift), a non-JSON error page, or
          // truly malformed JSON. Remove once the Bundle parse failure on
          // the smarthealthit sandbox is understood.
          Effect.tap((either) => {
            if (Either.isRight(either)) return Effect.void
            const contentType =
              response.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1]
              ?? '(none)'
            const head = response.text().slice(0, 200).replaceAll('\n', '\\n')
            return Effect.logWarning(
              `[debug] parse failed for entity ${entity.name} at ${response.url}: status=${response.status} content-type=${contentType} bytes=${response.byteLength} chunks=${response.chunkCount}\nfirst 200 chars: ${head}`
            )
          }),
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

    const warnAndDrop = (event: { readonly url: string }): Effect.Effect<void, never, never> =>
      Effect.logWarning(
        `CollectorBridgeMessageHandler.PageLoaded: handler is done; ignoring (url=${event.url})`
      )

    const PageLoaded: Service['PageLoaded'] = (event) =>
      // Atomic transition (serialized via SynchronizedRef):
      // - `AwaitingPageLoaded(n)`: schedule a fresh timer at `n` → `TimerPending(n, f)`.
      // - `TimerPending(d, f)`: interrupt `f`, then re-schedule at the same `d` →
      //   `TimerPending(d, f')`. This is the "page navigated again mid-wait" case;
      //   restart the wait without advancing the index.
      // - `Done`: WARN-log and stay in `Done`.
      SynchronizedRef.updateAndGetEffect(
        stepStateRef,
        Match.type<StepState>().pipe(
          Match.withReturnType<Effect.Effect<StepState>>(),
          Match.tag('TimerPending', (s) =>
            Fiber.interrupt(s.fiber).pipe(Effect.andThen(scheduleTimer(s.dispatchIndex)))
          ),
          Match.tag('AwaitingPageLoaded', (prior) => scheduleTimer(prior.nextIndex)),
          Match.tag('Done', (state) => warnAndDrop(event).pipe(Effect.as(state))),
          Match.exhaustive
        )
      ).pipe(Effect.asVoid)

    const reset: StepState = { _tag: 'AwaitingPageLoaded', nextIndex: 0 }

    const clear = (): Effect.Effect<void, never, never> =>
      // Atomic transition (serialized via SynchronizedRef): interrupt
      // any pending timer fiber, then reset the index to 0 regardless
      // of prior state. The daemon's fiber-identity check guards
      // against a racing commit from a not-yet-cancelled timer.
      SynchronizedRef.updateEffect(
        stepStateRef,
        Match.type<StepState>().pipe(
          Match.withReturnType<Effect.Effect<StepState>>(),
          Match.tag('TimerPending', (s) => Fiber.interrupt(s.fiber).pipe(Effect.as(reset))),
          Match.orElse(() => Effect.succeed(reset))
        )
      ).pipe(Effect.andThen(Effect.sync(() => MutableHashMap.clear(inProgressResponses))))

    const cancelAllInFlight = (
      send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
    ): Effect.Effect<void, never, never> =>
      // Atomic transition (serialized via SynchronizedRef):
      // - `TimerPending(d, f)`: interrupt `f`, fold to `AwaitingPageLoaded(d)`.
      //   A future `PageLoaded` would re-attempt the same step.
      // - `AwaitingPageLoaded(n)` / `Done`: leave alone.
      SynchronizedRef.updateEffect(
        stepStateRef,
        Match.type<StepState>().pipe(
          Match.withReturnType<Effect.Effect<StepState>>(),
          Match.tag('TimerPending', (prior) =>
            Fiber.interrupt(prior.fiber).pipe(
              Effect.as({ _tag: 'AwaitingPageLoaded', nextIndex: prior.dispatchIndex })
            )
          ),
          Match.orElse((state) => Effect.succeed(state))
        )
      ).pipe(
        Effect.andThen(
          Effect.all(
            Array.from(MutableHashMap.keys(inProgressResponses)).map((id) =>
              send({ _tag: 'CancelSnifferRequest', id })
            )
          )
        )
      )

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
  })

export type { CollectorBridgeMessageHandler, InProgressResponse, OutboundMessage }
export { make, SnifferCancelled }
