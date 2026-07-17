import { type CancelSnifferRequestMessage } from 'browser-sniffer-core'
import { Effect, Either, Mailbox, Ref } from 'effect'

import type { SniffResult } from './sniffer-response-tracker.ts'

/**
 * The run's termination surface: the one place every way a request-sniffing run
 * can end lives.
 *
 * A run is a bounded producer of {@link SniffResult}s on `requestSniffingResults`.
 * Its state is two independent facts: **sniffing** (the scripted navigation) is
 * `running → complete` (monotonic; once complete no new request can begin), and
 * the set of **incomplete sniffed requests** fluctuates as requests start and
 * settle. The stream closes when neither can produce more — sniffing complete
 * *and* no incomplete sniffed requests.
 *
 * - **`handleSniffingComplete`** — the scripted navigation dispatched its terminal
 *   `SniffingComplete`. Latch it, then close the stream if nothing is still
 *   incomplete; otherwise the last request to settle does.
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
   * Run after every settle: close `requestSniffingResults` iff sniffing is
   * complete *and* no sniffed request is still incomplete — i.e. no more results
   * can come. Idempotent — `Mailbox.end` is a no-op once closed. `handleNewSniffResult`
   * chains this after each publish; `handleSniffingComplete` after latching.
   */
  readonly endRequestSniffingResultsUnlessMoreExpected: Effect.Effect<void, never, never>
  /** Latch that scripted sniffing finished; close the stream if nothing is incomplete. */
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

    const endRequestSniffingResultsUnlessMoreExpected: Effect.Effect<void, never, never> =
      Effect.gen(function* () {
        // More results are still expected while sniffing has not finished (it may
        // start new requests) or any sniffed request is still incomplete.
        if (!(yield* Ref.get(sniffingComplete))) return
        if (hasIncompleteSniffedRequests()) return
        yield* requestSniffingResults.end
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
    // not a hang. It force-closes rather than deferring to the normal end-check
    // because at an idle timeout sniffing may not yet be complete.
    const abandonAllRequestSniffing: Effect.Effect<void, never, never> =
      failIncompleteSniffedRequests.pipe(Effect.andThen(requestSniffingResults.end))

    // Unmount teardown: stop the scripted navigation, then ask the host to cancel
    // the incomplete requests. Navigation-first is not load-bearing (the machines
    // share no state) but is preserved so the externally visible outbound-message
    // order is unchanged.
    const cancelAllRequestSniffing = (
      send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
    ): Effect.Effect<void, never, never> =>
      stopAutomaticNavigation().pipe(Effect.andThen(cancelIncompleteSniffedRequests(send)))

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
export { make }
