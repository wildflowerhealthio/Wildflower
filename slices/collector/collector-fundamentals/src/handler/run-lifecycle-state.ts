import { type CancelSnifferRequestMessage } from 'browser-sniffer-core'
import { Duration, Effect, Either, Fiber, Mailbox, Ref } from 'effect'
import type { RuntimeFiber } from 'effect/Fiber'

import type { SniffResult } from './sniffer-response-tracker.ts'

/**
 * Grace window between quiescence first holding (sniffing complete *and* no
 * sniffed request incomplete) and actually closing `requestSniffingResults`.
 *
 * The sniffer's `fetch` / `XHR` shims stay installed on the page after
 * `SniffingComplete` — "sniffing complete" means the scripted navigation is
 * exhausted, not that the page can no longer issue requests. So a lazily-fired
 * request can still surface a `ResponseStart` a beat later; closing the instant
 * the incomplete map first empties would track that straggler into an
 * already-closed stream and drop its result silently (not even as a failure).
 * Arming a short settle instead lets a late `ResponseStart` re-populate the map
 * before the close is confirmed. Mirrors the `SHORT_CONFIRM_WINDOW` the
 * pre-extraction `use-sync-runner` drive loop kept for the same reason.
 */
const SETTLE_CONFIRM_WINDOW: Duration.DurationInput = Duration.millis(250)

/**
 * The run's termination surface: the one place every way a request-sniffing run
 * can end lives.
 *
 * A run is a bounded producer of {@link SniffResult}s on `requestSniffingResults`.
 * Its state is two independent facts: **sniffing** (the scripted navigation) is
 * `running → complete` (monotonic; the scripted navigation is exhausted), and
 * the set of **incomplete sniffed requests** fluctuates as requests start and
 * settle. The stream closes once neither can produce more — sniffing complete
 * *and* no incomplete sniffed requests — but only after a short
 * {@link SETTLE_CONFIRM_WINDOW} settle, because the page's shims stay live and a
 * straggler `ResponseStart` can still arrive just after quiescence first holds.
 *
 * - **`handleSniffingComplete`** — the scripted navigation dispatched its terminal
 *   `SniffingComplete`. Latch it, then (if nothing is still incomplete) arm the
 *   settle window; otherwise the last request to settle does.
 * - **`abandonAllRequestSniffing`** — the idle-timeout escape. Publish every
 *   still-incomplete sniffed request as a failure and close the stream *now*, so
 *   the run reports the loss instead of hanging on a silent host.
 * - **`cancelAllRequestSniffing`** — the screen-unmount teardown. Stop the
 *   automatic navigation and ask the host to `CancelSnifferRequest` every
 *   incomplete request (so the page stops streaming to a handler nobody reads);
 *   publishes nothing and leaves the stream open (the consumer has gone).
 *
 * The lifecycle owns `requestSniffingResults` and the `sniffingComplete` latch;
 * it reads *whether any request is still incomplete* through the injected
 * `hasIncompleteSniffedRequests` — the tracker's map stays the single source of
 * truth, so there is no shadow counter to drift. It reaches the response tracker
 * and automatic-navigation machine only through the injected hooks; neither machine reads the
 * other's state. See the [Handler Explanation](../../docs/Handler%20Explanation.md).
 */
interface RunLifecycleState<TResources> {
  /**
   * The stream of settled {@link SniffResult}s, surfaced as the handler's
   * result source. The lifecycle closes it on `handleSniffingComplete` (once no
   * request is incomplete) or `abandonAllRequestSniffing`. Once closed *and*
   * drained, a consumer's `take` fails with `NoSuchElementException` — the run's
   * completion signal.
   */
  readonly requestSniffingResults: Mailbox.ReadonlyMailbox<SniffResult<TResources>>
  /**
   * Publish one settled result onto `requestSniffingResults` (a synchronous
   * `unsafeOffer`), then run `endRequestSniffingResultsUnlessMoreExpected` so the
   * stream closes if this was the last thing it was waiting on. The tracker is
   * the sole caller, and it drops the settled id *before* calling this — so the
   * offer lands before the end-check, and the end-check sees the request gone.
   * The idle-timeout abandon path publishes with `abandoned` set: it
   * force-closes the stream itself, so the per-result end-check is skipped.
   */
  readonly handleNewSniffResult: (
    result: SniffResult<TResources>
  ) => Effect.Effect<void, never, never>
  /**
   * Run after every settle: if sniffing is complete *and* no sniffed request is
   * still incomplete, arm the {@link SETTLE_CONFIRM_WINDOW} settle-close (which
   * re-confirms against live state before ending the stream); otherwise do
   * nothing. Interrupt-and-replace, so each fresh quiescence restarts the
   * window. `handleNewSniffResult` chains this after each publish;
   * `handleSniffingComplete` after latching.
   */
  readonly endRequestSniffingResultsUnlessMoreExpected: Effect.Effect<void, never, never>
  /** Latch that scripted sniffing finished; arm the settle-close if nothing is incomplete. */
  readonly handleSniffingComplete: Effect.Effect<void, never, never>
  /** Idle escape: publish every incomplete request as a failure, then close the stream. */
  readonly abandonAllRequestSniffing: Effect.Effect<void, never, never>
  /** Unmount teardown: stop navigation + `CancelSnifferRequest` each incomplete request; no close. */
  readonly cancelAllRequestSniffing: (
    send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
  ) => Effect.Effect<void, never, never>
}

/**
 * Build the {@link RunLifecycleState}. Owns `requestSniffingResults` and the
 * `sniffingComplete` latch; the end-paths are composed from the injected tracker
 * and automatic-navigation hooks. `hasIncompleteSniffedRequests` reads the tracker's map
 * (the sole quiescence source), `failIncompleteSniffedRequests` publishes the
 * still-incomplete requests as failures and drops them *without* closing — the
 * lifecycle owns the close.
 */
const make = <TResources>({
  hasIncompleteSniffedRequests,
  failIncompleteSniffedRequests,
  cancelIncompleteSniffedRequests,
  stopAutomaticNavigation,
}: {
  readonly hasIncompleteSniffedRequests: () => boolean
  readonly failIncompleteSniffedRequests: Effect.Effect<void, never, never>
  readonly cancelIncompleteSniffedRequests: (
    send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
  ) => Effect.Effect<void, never, never>
  readonly stopAutomaticNavigation: () => Effect.Effect<void, never, never>
}): Effect.Effect<RunLifecycleState<TResources>, never, never> =>
  Effect.gen(function* () {
    const requestSniffingResults = yield* Mailbox.make<SniffResult<TResources>>()
    // Set true once `SniffingComplete` is observed. The stream closes when this
    // holds *and* no sniffed request is incomplete — checked by
    // `endRequestSniffingResultsUnlessMoreExpected` after each settle and when
    // the latch is first set.
    const sniffingComplete = yield* Ref.make(false)
    // Single-slot handle for the pending settle-close daemon (see
    // `SETTLE_CONFIRM_WINDOW`). Interrupt-and-replace so each fresh quiescence
    // restarts the window; interrupted at teardown so the daemon — a
    // `forkDaemon`, untied to the run scope — can't outlive the run.
    const pendingCloseFiber = yield* Ref.make<RuntimeFiber<void, never> | null>(null)

    // Close the stream iff quiescence still holds. Re-checked against *live*
    // state because a straggler `ResponseStart` may have re-populated the map
    // during the settle window. Idempotent — `Mailbox.end` is a no-op once
    // closed.
    const confirmAndCloseIfStillQuiescent: Effect.Effect<void, never, never> = Effect.gen(
      function* () {
        if (!(yield* Ref.get(sniffingComplete))) return
        if (hasIncompleteSniffedRequests()) return
        yield* requestSniffingResults.end
      }
    )

    // Interrupt any pending settle-close daemon (a no-op when none is armed).
    const cancelPendingClose: Effect.Effect<void, never, never> = Effect.gen(function* () {
      const existing = yield* Ref.getAndSet(pendingCloseFiber, null)
      if (existing !== null) yield* Fiber.interrupt(existing)
    })

    // Arm (or re-arm) the settle-close: interrupt any pending daemon so the
    // window restarts from now, then fork one that sleeps the window and
    // re-confirms before closing. A `forkDaemon` (not `fork`) because the
    // arming fiber is the message dispatcher's, which completes as soon as the
    // handler returns — a child fiber would be interrupted immediately.
    const armSettleClose: Effect.Effect<void, never, never> = Effect.gen(function* () {
      yield* cancelPendingClose
      const fiber = yield* Effect.forkDaemon(
        Effect.gen(function* () {
          yield* Effect.sleep(SETTLE_CONFIRM_WINDOW)
          yield* Ref.set(pendingCloseFiber, null)
          yield* confirmAndCloseIfStillQuiescent
        })
      )
      yield* Ref.set(pendingCloseFiber, fiber)
    })

    const endRequestSniffingResultsUnlessMoreExpected: Effect.Effect<void, never, never> =
      Effect.gen(function* () {
        // More results are still expected while sniffing has not finished (it may
        // start new requests) or any sniffed request is still incomplete.
        if (!(yield* Ref.get(sniffingComplete))) return
        if (hasIncompleteSniffedRequests()) return
        // Quiescent — but don't close yet: arm a short settle so a late
        // `ResponseStart` (the shims stay live post-`SniffingComplete`) can
        // re-populate the map before the close is confirmed.
        yield* armSettleClose
      })

    const handleNewSniffResult = (
      result: SniffResult<TResources>
    ): Effect.Effect<void, never, never> => {
      requestSniffingResults.unsafeOffer(result)
      // The idle-timeout abandon path (`failIncompleteSniffedRequests`) publishes
      // each stalled request `abandoned` before force-closing the stream itself,
      // so running the end-check per result there is pointless — the map isn't
      // cleared until every failure is published. Skip it for those.
      const abandoned = Either.match(result, {
        onLeft: (error) => error.abandoned,
        onRight: () => false,
      })
      if (abandoned) {
        return Effect.void
      }
      return endRequestSniffingResultsUnlessMoreExpected
    }

    const handleSniffingComplete: Effect.Effect<void, never, never> = Ref.set(
      sniffingComplete,
      true
    ).pipe(Effect.andThen(endRequestSniffingResultsUnlessMoreExpected))

    // Publish every incomplete request as a failure, then force-close the stream
    // (the close is the lifecycle's), so a stalled host is reported as a loss,
    // not a hang. It force-closes rather than deferring to the settle-close
    // because at an idle timeout sniffing may not yet be complete; cancel any
    // pending settle first so it can't race this close (and can't leak).
    const abandonAllRequestSniffing: Effect.Effect<void, never, never> = cancelPendingClose.pipe(
      Effect.andThen(failIncompleteSniffedRequests),
      Effect.andThen(requestSniffingResults.end)
    )

    // Unmount teardown: stop the scripted navigation, then ask the host to cancel
    // the incomplete requests. Navigation-first is not load-bearing (the machines
    // share no state) but is preserved so the externally visible outbound-message
    // order is unchanged. Also interrupt any pending settle-close daemon so it
    // can't outlive the run (it is a `forkDaemon`, untied to the run scope).
    const cancelAllRequestSniffing = (
      send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
    ): Effect.Effect<void, never, never> =>
      cancelPendingClose.pipe(
        Effect.andThen(stopAutomaticNavigation()),
        Effect.andThen(cancelIncompleteSniffedRequests(send))
      )

    return {
      requestSniffingResults,
      handleNewSniffResult,
      endRequestSniffingResultsUnlessMoreExpected,
      handleSniffingComplete,
      abandonAllRequestSniffing,
      cancelAllRequestSniffing,
    }
  })

export type { RunLifecycleState }
export { make, SETTLE_CONFIRM_WINDOW }
