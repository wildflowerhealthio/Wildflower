import { type CancelSnifferRequestMessage } from 'browser-sniffer-core'
import { Effect, Either, Mailbox, Ref } from 'effect'

import type { SniffResult } from './sniffer-response-tracker.ts'

/**
 * The run's termination surface: the one place every way a request-sniffing run
 * can end lives.
 *
 * A run is a bounded producer of {@link SniffResult}s on `requestSniffingResults`.
 * Its state is two independent facts: **sniffing** (the scripted navigation) is
 * `running → complete` (monotonic; the machine's step queue drains and, once no
 * request can still generate more work, it dispatches `SniffingComplete`), and
 * the set of **incomplete sniffed requests** fluctuates as requests start and
 * settle. The stream closes once neither can produce more — sniffing complete
 * *and* no incomplete sniffed requests.
 *
 * **Completion is now coupled across the two machines.** With breadth-first
 * `followUpSteps` generation, the automatic-navigation machine cannot declare
 * completion just because its queue is empty — any in-flight request could still
 * parse into follow-ups. So natural completion is *queue drained ∧ no incomplete
 * request*, and Gate A (the machine's `SniffingComplete`) *depends on* Gate B
 * (this map), mediated by the lifecycle: whenever the incomplete map empties, the
 * lifecycle injects `NoMoreResultsExpected` into the machine (`signalNoMoreResultsExpected`),
 * which completes it iff its queue is already drained. The machines still share
 * no state — both facts flow as explicit inputs/hooks. There is no implicit
 * settle window: a plan that needs post-load XHR fan-out to finish before
 * completing inserts an explicit trailing `Delay` step.
 *
 * - **`handleSniffingComplete`** — the machine reached `Done` and dispatched its
 *   terminal `SniffingComplete` (via `NoMoreResultsExpected`, or a
 *   url-match-timeout abort). Latch Gate A and close the stream — unless a
 *   request is still incomplete (an abort can fire mid-flight), in which case the
 *   last settle's end-check closes it.
 * - **`abandonAllRequestSniffing`** — the force-close escape. Stop the machine
 *   (so a parked timer can't leak), publish every still-incomplete request as a
 *   failure, and close the stream *now*, so a caller can report the loss instead
 *   of hanging on a silent host. Driven by the automatic-navigation machine's
 *   **drained guard**, the only bound on Gate B — see the
 *   [Handler Explanation](../../docs/Handler%20Explanation.md#the-drained-guard-the-only-bound-on-gate-b).
 *   The runner drives nothing here.
 * - **`cancelAllRequestSniffing`** — the screen-unmount teardown. Stop the
 *   automatic navigation and ask the host to `CancelSnifferRequest` every
 *   incomplete request; publishes nothing and leaves the stream open (the
 *   consumer has gone).
 *
 * The lifecycle owns `requestSniffingResults` and the `sniffingComplete` latch;
 * it reads *whether any request is still incomplete* through the injected
 * `hasIncompleteSniffedRequests` — the tracker's map stays the single source of
 * truth, so there is no shadow counter to drift. It reaches the response tracker
 * and automatic-navigation machine only through the injected hooks; neither
 * machine reads the other's state. See the
 * [Handler Explanation](../../docs/Handler%20Explanation.md).
 */
interface RunLifecycleState<TParsed> {
  /**
   * The stream of settled {@link SniffResult}s, surfaced as the handler's
   * result source. The lifecycle closes it on `handleSniffingComplete` (once no
   * request is incomplete) or `abandonAllRequestSniffing`. Once closed *and*
   * drained, a consumer's `take` fails with `NoSuchElementException` — the run's
   * completion signal.
   */
  readonly requestSniffingResults: Mailbox.ReadonlyMailbox<SniffResult<TParsed>>
  /**
   * Publish one settled result onto `requestSniffingResults` (a synchronous
   * `unsafeOffer`), then run `endRequestSniffingResultsUnlessMoreExpected` so the
   * machine is told when the map has emptied (and the stream closes if it was the
   * last thing awaited). The tracker is the sole caller, and it drops the settled
   * id *before* calling this — so the offer lands before the end-check, and the
   * end-check sees the request gone. The abandon path publishes with
   * `abandoned` set: it force-closes the stream itself, so the per-result
   * end-check is skipped.
   */
  readonly handleNewSniffResult: (result: SniffResult<TParsed>) => Effect.Effect<void, never, never>
  /**
   * Run after every settle *and* whenever the machine's queue drains (wired to
   * its `onDrained` hook): if no sniffed request is still incomplete, inject
   * `NoMoreResultsExpected` into the machine (completing it iff its queue is
   * drained) and — if sniffing is already complete — close the stream. If a
   * request is still incomplete, more results are expected, so do nothing.
   */
  readonly endRequestSniffingResultsUnlessMoreExpected: Effect.Effect<void, never, never>
  /** The machine reached `Done`: latch Gate A and close the stream if nothing is incomplete. */
  readonly handleSniffingComplete: Effect.Effect<void, never, never>
  /** Force-close escape: stop the machine, publish every incomplete request as a failure, then close. */
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
 * lifecycle owns the close — and `signalNoMoreResultsExpected` injects the
 * completion input into the automatic-navigation machine.
 */
const make = <TParsed>({
  hasIncompleteSniffedRequests,
  failIncompleteSniffedRequests,
  cancelIncompleteSniffedRequests,
  stopAutomaticNavigation,
  signalNoMoreResultsExpected,
}: {
  readonly hasIncompleteSniffedRequests: () => boolean
  readonly failIncompleteSniffedRequests: Effect.Effect<void, never, never>
  readonly cancelIncompleteSniffedRequests: (
    send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
  ) => Effect.Effect<void, never, never>
  readonly stopAutomaticNavigation: () => Effect.Effect<void, never, never>
  /**
   * Inject `NoMoreResultsExpected` into the automatic-navigation machine. The
   * machine completes (`Drained → Done`, dispatching `SniffingComplete`) iff its
   * queue is drained, and otherwise no-ops. Forward-referenced by the
   * composition (the machine is built after the lifecycle).
   */
  readonly signalNoMoreResultsExpected: Effect.Effect<void, never, never>
}): Effect.Effect<RunLifecycleState<TParsed>, never, never> =>
  Effect.gen(function* () {
    const requestSniffingResults = yield* Mailbox.make<SniffResult<TParsed>>()
    // Set true once the machine dispatches `SniffingComplete`. The stream closes
    // when this holds *and* no sniffed request is incomplete.
    const sniffingComplete = yield* Ref.make(false)

    const endRequestSniffingResultsUnlessMoreExpected: Effect.Effect<void, never, never> =
      Effect.gen(function* () {
        // More results are still expected while any sniffed request is
        // incomplete — it may yet parse into follow-up steps.
        if (hasIncompleteSniffedRequests()) return
        // The map is empty. Tell the machine (completes it iff its queue is
        // drained); this is also how a trailing `Delay` completes — the machine's
        // `onDrained` hook routes here when the queue drains onto an empty map.
        yield* signalNoMoreResultsExpected
        // If the machine has already reached `Done` (just now, or on an earlier
        // url-match-timeout abort whose in-flight requests have since settled),
        // close the stream.
        if (yield* Ref.get(sniffingComplete)) yield* requestSniffingResults.end
      })

    const handleNewSniffResult = (
      result: SniffResult<TParsed>
    ): Effect.Effect<void, never, never> => {
      requestSniffingResults.unsafeOffer(result)
      // The abandon path (`failIncompleteSniffedRequests`) publishes
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

    // The machine reached `Done` and dispatched `SniffingComplete` (via the
    // `onSniffingComplete` hook). Latch Gate A, then close the stream — but only
    // if no request is still incomplete. A url-match-timeout abort reaches `Done`
    // with requests possibly in flight; those results must still drain, and the
    // last settle's end-check does the close. Never dispatches back to the machine
    // (it does not call the end-check), so it can't re-enter the machine's lock.
    const handleSniffingComplete: Effect.Effect<void, never, never> = Effect.gen(function* () {
      yield* Ref.set(sniffingComplete, true)
      if (!hasIncompleteSniffedRequests()) {
        yield* requestSniffingResults.end
      }
    })

    // Force-close escape: stop the machine first (interrupt any pending `Delay` /
    // URL-match timer so a parked state can't leak one), publish every incomplete
    // request as a failure, then force-close the stream — a stalled host is
    // reported as a loss, not a hang. Wrapped in `Effect.gen` (not an eager
    // `.pipe`) so `stopAutomaticNavigation()` is invoked at run time, not while
    // constructing this value — the machine is a forward reference built after
    // the lifecycle, so calling it during construction would hit its TDZ.
    const abandonAllRequestSniffing: Effect.Effect<void, never, never> = Effect.gen(function* () {
      yield* stopAutomaticNavigation()
      yield* failIncompleteSniffedRequests
      yield* requestSniffingResults.end
    })

    // Unmount teardown: stop the scripted navigation, then ask the host to cancel
    // the incomplete requests. Navigation-first is not load-bearing (the machines
    // share no state) but is preserved so the externally visible outbound-message
    // order is unchanged. Publishes nothing and leaves the stream open.
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
