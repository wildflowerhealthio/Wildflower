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

/**
 * Step-driver finite state machine. Each variant carries exactly the
 * data needed for that state — no shared optional fields, no
 * sentinels for "running but no timer yet".
 *
 * Transitions:
 *   AwaitingPageLoaded(n)   ─PageLoaded→ TimerPending(n, fiber)
 *   TimerPending(d, f)      ─PageLoaded→ TimerPending(d, fiber')   (f interrupted; fresh fiber)
 *   TimerPending(d, _)      ─timer fires, d < N→ AwaitingPageLoaded(d + 1)
 *   TimerPending(N, _)      ─timer fires, d ≡ N→ Done
 *   Done                    ─PageLoaded→ Done (WARN-log)
 *   any                     ─clear()→ AwaitingPageLoaded(0)
 *   any                     ─cancelAllInFlight→ AwaitingPageLoaded(d) (d preserved)
 *
 * Atomicity is preserved by using `MutableRef.compareAndSet` /
 * `MutableRef.getAndSet` / `MutableRef.getAndUpdate` everywhere a
 * read-then-write would otherwise be torn by a concurrent
 * transition. Identity is the `TimerPending` value's object
 * reference: each `scheduleTimer` call mints a fresh frozen object
 * that the timer's commit captures in closure, then `compareAndSet`s
 * back. If any other transition (`PageLoaded` re-arm, `clear`,
 * `cancelAllInFlight`) has swapped a different reference into the
 * cell, the commit's CAS returns `false` and exits without
 * overwriting the replacement.
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
  const stepState = MutableRef.make<StepState>({ _tag: 'AwaitingPageLoaded', nextIndex: 0 })

  /**
   * Schedule a fresh timer for `dispatchIndex`. The timer fiber:
   *   1. Sleeps for `stepDelay`.
   *   2. Inside an `Effect.uninterruptible` block: dispatches the
   *      indexed message, then `compareAndSet`s `stepState` from its
   *      own captured `TimerPending` reference to the post-dispatch
   *      state.
   *
   * The CAS gives us optimistic atomicity for free: any other
   * transition (`PageLoaded` re-arm, `clear`, `cancelAllInFlight`)
   * writes a *different* reference into `stepState`, so the commit's
   * `compareAndSet` returns `false` and exits without overwriting
   * the replacement. The captured reference is the `TimerPending`
   * object the same scheduling call publishes — bridged through a
   * mutable closure cell because the fiber needs the reference of
   * the state record it identifies, which can only be built after
   * `forkDaemon` returns the fiber.
   *
   * Caller responsibility: interrupt any prior `TimerPending` fiber
   * before invoking `scheduleTimer` — orphan fibers from skipped
   * interrupts still die safely (their CAS fails) but waste a
   * `stepDelay`-length sleep.
   */
  const scheduleTimer = (dispatchIndex: number): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      // Closure cell: holds the `TimerPending` reference this fiber's
      // commit will `compareAndSet` against. Filled in after fork.
      const expectedRef: { value: StepState | null } = { value: null }
      const fiber = yield* Effect.forkDaemon(
        Effect.gen(function* () {
          yield* Effect.sleep(scrapingPlan.stepDelay)
          const expected = expectedRef.value
          // Belt-and-braces: the cell is always set before sleep can
          // resume (single-threaded JS — the post-fork lines run
          // before the fiber's sleep yields again), but guard anyway.
          if (expected === null) return
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (dispatchIndex < scrapingPlan.linkSequence.length) {
                // `Link.Open` / `Link.Click` are structurally identical
                // to the `Open` / `Click` bridge messages — forward
                // verbatim.
                yield* sendMessage(scrapingPlan.linkSequence[dispatchIndex])
                MutableRef.compareAndSet(stepState, expected, {
                  _tag: 'AwaitingPageLoaded',
                  nextIndex: dispatchIndex + 1,
                })
              } else {
                yield* sendMessage({ _tag: 'SniffingComplete' })
                MutableRef.compareAndSet(stepState, expected, { _tag: 'Done' })
              }
            })
          )
        })
      )
      const installed: StepState = { _tag: 'TimerPending', dispatchIndex, fiber }
      expectedRef.value = installed
      MutableRef.set(stepState, installed)
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

  const warnAndDrop = (event: { readonly url: string }): Effect.Effect<void, never, never> =>
    Effect.logWarning(
      `CollectorBridgeMessageHandler.PageLoaded: handler is done; ignoring (url=${event.url})`
    )

  const PageLoaded: Service['PageLoaded'] = (event) =>
    Effect.gen(function* () {
      // Atomic conditional swap: if a timer was pending, fold it back
      // to `AwaitingPageLoaded(dispatchIndex)` so re-arm restarts the
      // wait at the same index. `Done` / `AwaitingPageLoaded` stay
      // as-is. Returns the *prior* state so we know whether there's a
      // fiber to interrupt and what index to schedule.
      const prior = MutableRef.getAndUpdate(
        stepState,
        (s): StepState =>
          s._tag === 'TimerPending' ? { _tag: 'AwaitingPageLoaded', nextIndex: s.dispatchIndex } : s
      )
      if (prior._tag === 'Done') {
        yield* warnAndDrop(event)
        return
      }
      if (prior._tag === 'TimerPending') {
        // Interrupt awaited. Effect.uninterruptible may defer the
        // interrupt until the commit block exits, but the commit's
        // `compareAndSet` against the now-stale `TimerPending`
        // reference fails — the swap above replaced the cell — so
        // no transition leaks past `clear`'s reset state.
        yield* Fiber.interrupt(prior.fiber)
      }
      // After the interrupt resolves, `stepState` is `AwaitingPageLoaded(d)`
      // (set by the `getAndUpdate` above) unless a concurrent
      // `PageLoaded` raced in between — in which case it's a new
      // `TimerPending` we should interrupt before scheduling our own.
      const current = MutableRef.get(stepState)
      if (current._tag === 'Done') {
        yield* warnAndDrop(event)
        return
      }
      const dispatchIndex =
        current._tag === 'AwaitingPageLoaded' ? current.nextIndex : current.dispatchIndex
      if (current._tag === 'TimerPending') {
        yield* Fiber.interrupt(current.fiber)
      }
      yield* scheduleTimer(dispatchIndex)
    })

  const clear = (): void => {
    // Atomic swap: pull the prior state, install the reset. Any
    // in-flight timer commit's `compareAndSet` against its captured
    // `TimerPending` reference fails because the cell now holds a
    // different object — the reset state survives.
    const prior = MutableRef.getAndSet(stepState, {
      _tag: 'AwaitingPageLoaded',
      nextIndex: 0,
    } satisfies StepState)
    if (prior._tag === 'TimerPending') {
      // Fire-and-forget — `clear` is synchronous and we'd rather not
      // hold a React unmount path waiting on fiber teardown. The
      // dead fiber can't disturb the reset state thanks to the CAS
      // guard inside its commit.
      Effect.runFork(Fiber.interrupt(prior.fiber))
    }
    for (const key of MutableHashMap.keys(inProgressResponses)) {
      MutableHashMap.remove(inProgressResponses, key)
    }
  }

  const cancelAllInFlight = (
    send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
  ): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      // Atomic conditional swap: if `TimerPending`, fold to
      // `AwaitingPageLoaded(d)` so a future `PageLoaded` would
      // re-attempt the same step; if already `AwaitingPageLoaded` or
      // `Done`, leave alone. Same CAS-friendly identity story as
      // `clear` — any in-flight commit fails its `compareAndSet`
      // against the now-stale reference.
      const prior = MutableRef.getAndUpdate(
        stepState,
        (s): StepState =>
          s._tag === 'TimerPending' ? { _tag: 'AwaitingPageLoaded', nextIndex: s.dispatchIndex } : s
      )
      if (prior._tag === 'TimerPending') {
        yield* Fiber.interrupt(prior.fiber)
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
