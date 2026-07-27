/**
 * The framework-free core of the collector sync runner: the drive
 * {@link processSniffResultsFromMailbox} that turns the run's events — drained from the
 * handler's `requestSniffingResults` stream it is handed — into a `Stream` of
 * write outcomes, and {@link collectImportSummary} that folds that stream into
 * the {@link ImportSummary}. Extracted from `use-sync-runner.ts` so it is
 * unit-testable with `TestClock` (no React Testing Library).
 *
 * This module has **no React imports** — the hook (`use-sync-runner.ts`)
 * owns the mutation wiring, the `AbortController`, and the `RunnerState`
 * mapping, and injects the two React-facing callbacks (`setFailed` /
 * `onError`) as plain functions.
 *
 * The runner is **fully generic** over a collector's resource type
 * (`Resources`) and its write requirement (`R`): it hands each decoded batch to
 * the injected `persistResources`
 * ({@link CollectorDescriptor.ResourcePersistenceContext}) and never names a
 * collector's resource union. The sink owns *how* a batch is written (retries,
 * per-resource spans, concurrency) and returns the resources it could not write
 * as {@link CollectorDescriptor.PersistFailure} data; the runner owns *when* to
 * write, the batch `collector.importing` span, and folding those failures into
 * the summary.
 *
 * The run's output is **produced by a `Stream`**: {@link processSniffResultsFromMailbox}
 * emits one chunk of failures per drive step (via `Stream.paginateEffect`, so
 * the idle-timeout abandon tail still emits), and {@link collectImportSummary}
 * runs the fold. The drive step is a plain decision table — **not** an FSM
 * (unlike the browser-sniffer automatic-navigation machine, which models concurrent,
 * interruptible timers; this does not). Completion is not computed here: it is
 * the handler's `requestSniffingResults` stream finishing (the handler closes it
 * at sniff-complete + drained) — see the timeline in
 * `collector-fundamentals/docs/Collector Sync Explanation.md`.
 */
import { CollectorBridgeMessageHandler } from 'collector-fundamentals/handler'
import type { CollectorDescriptor } from 'collector-fundamentals/model'
import * as Telemetry from 'collector-fundamentals/telemetry'
import type { Mailbox } from 'effect'
import { Duration, Effect, Either, Option, Stream } from 'effect'

import { captureLinkedSpan } from './capture-linked-span.ts'
import type { CollectorSender } from './collector-sender-context.ts'
import type { useCollectorRegister } from './use-collector-register.ts'

/**
 * Identifier of a resource whose write failed (or a response that failed to
 * parse), surfaced via the `partial` runner state so the UI can render "N of M
 * synced". Just the descriptor's {@link CollectorDescriptor.FailedResource}
 * label/id — the runner never inspects a resource's fields itself.
 */
type FailedResource = CollectorDescriptor.FailedResource

/**
 * Summary the long import Effect resolves with. `cancelled` is `true`
 * only when an explicit {@link SyncRunner.cancel} aborted the run —
 * the caller maps that back to `idle` rather than a terminal state.
 */
interface ImportSummary {
  readonly failed: ReadonlyArray<FailedResource>
  readonly cancelled: boolean
}

/**
 * The drive loop's queue element — one settled sniff outcome straight from the
 * bridge handler ({@link CollectorBridgeMessageHandler.SniffResult}): `Right` a
 * decoded batch, `Left` a sniff-level failure keyed on the URL. The runner drains
 * the handler's `requestSniffingResults` stream directly, so this *is* the queue
 * element — there is no per-write event (a batch's writes are awaited inside the
 * drive step) and no synthetic completion event: completion is the stream
 * finishing, not anything offered onto the queue.
 */
type SniffResult<Resources> = CollectorBridgeMessageHandler.SniffResult<Resources>

/** Stalled-host guard window when neither the caller nor the plan sets one. */
const DEFAULT_IDLE_TIMEOUT: Duration.DurationInput = Duration.seconds(30)

/**
 * Resolve a run's silent-host idle guard, **most specific first**: an explicit
 * caller override, then the collector's own `ScrapingPlan.idleTimeout`, then
 * {@link DEFAULT_IDLE_TIMEOUT}.
 *
 * The caller is ahead of the plan deliberately. Someone passing a timeout is
 * overriding it for this run, and plan data — which the caller may not even know
 * about — must not silently win over an explicit argument. That ordering only
 * works if callers pass `undefined` when they have no opinion instead of
 * pre-defaulting: a defaulted value is indistinguishable from a chosen one here,
 * and would mean the plan's guard could never take effect.
 */
const resolveIdleTimeout = (
  callerIdleTimeout: Duration.DurationInput | undefined,
  planIdleTimeout: Duration.DurationInput | undefined
): Duration.DurationInput => callerIdleTimeout ?? planIdleTimeout ?? DEFAULT_IDLE_TIMEOUT

/**
 * The drive loop as a `Stream` over the handler's read-only results mailbox
 * (passed as `sniffResultMailbox`). **Completion is folded into that mailbox** — the
 * handler `end`s it once sniffing is complete and every response has settled
 * (or, at an idle timeout, via the abandon action) — so "are we done?" is
 * simply "has the mailbox finished draining?" There is no separate quiescence
 * check here: no sniff-complete signal and no in-flight-response map live in the
 * runner. Failures are not stored either — each step emits its batch's failures
 * as data and {@link collectImportSummary} accumulates them; a processed event
 * leaves its writes already settled (the step awaits each batch inline).
 *
 * Each step waits on the mailbox, acts, and emits the chunk of
 * {@link CollectorDescriptor.PersistFailure} that step produced (empty when it
 * wrote nothing), until the mailbox is `done`. A plain decision table, not a
 * state machine (contrast the automatic-navigation machine's overlapping timers). The completion
 * timeline is documented in
 * `collector-fundamentals/docs/Collector Sync Explanation.md`.
 *
 * - `event` → hand the batch to `processSniffResult` (its failures emitted), loop.
 * - `done` → the mailbox finished and drained; the run is complete.
 * - `idle` → nothing arrived within `idleTimeout`: a response stalled or the
 *   host went silent. Run `onIdleTimeout` — which settles any still-in-flight
 *   response as a failure on the mailbox and `end`s it — then loop to drain
 *   those failures and observe `done`. (`Stream.paginateEffect`, not `repeat`,
 *   so that draining tail still emits.)
 *
 * `sniffResultMailbox`, `processSniffResult`, and `onIdleTimeout` are injected so this stays a
 * small, `TestClock`-testable unit independent of the bridge handler. Generic
 * over the collector's `Resources` and the write requirement `R`.
 */
const processSniffResultsFromMailbox = <Resources, R>({
  sniffResultMailbox,
  processSniffResult,
  onIdleTimeout,
  idleTimeout,
}: {
  readonly sniffResultMailbox: Mailbox.ReadonlyMailbox<SniffResult<Resources>>
  readonly processSniffResult: (
    event: SniffResult<Resources>
  ) => Effect.Effect<ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R>
  readonly onIdleTimeout: Effect.Effect<void, never, R>
  readonly idleTimeout: Duration.DurationInput
}): Stream.Stream<ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R> =>
  Stream.paginateEffect<void, ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R>(
    undefined,
    () =>
      sniffResultMailbox.take.pipe(
        Effect.timeoutTo({
          duration: idleTimeout,
          onSuccess: (
            event
          ): Effect.Effect<
            readonly [ReadonlyArray<CollectorDescriptor.PersistFailure>, Option.Option<void>],
            never,
            R
          > =>
            Effect.map(
              processSniffResult(event),
              (
                produced
              ): readonly [
                ReadonlyArray<CollectorDescriptor.PersistFailure>,
                Option.Option<void>,
              ] => [produced, Option.some<void>(undefined)] as const
            ),
          onTimeout: (): Effect.Effect<
            readonly [ReadonlyArray<CollectorDescriptor.PersistFailure>, Option.Option<void>],
            never,
            R
          > => Effect.as(onIdleTimeout, [[], Option.some<void>(undefined)] as const),
        }),
        Effect.flatten,
        Effect.catchTag('NoSuchElementException', () =>
          // `done`: the mailbox finished and drained — the run is complete.
          Effect.succeed<
            readonly [ReadonlyArray<CollectorDescriptor.PersistFailure>, Option.Option<void>]
          >([[], Option.none<void>()] as const)
        )
      )
  )

/**
 * Run the drive {@link Stream} and fold its per-step failure chunks into the
 * {@link ImportSummary}. This fold *is* the run's output: `setFailed` receives
 * the growing cumulative list (once per failure, so the `partial` UI count
 * updates at the same cadence as before), and `onError` fires once per failure
 * with its real `cause`. `runFoldEffect` manages the stream's scope, so the
 * result's requirement is just the write `R`.
 */
const collectImportSummary = <R>(
  failures: Stream.Stream<ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R>,
  handleFailureSetUpdated: (failed: ReadonlyArray<FailedResource>) => void,
  handleNewFailureCause: (cause: unknown) => void
): Effect.Effect<ImportSummary, never, R> =>
  failures.pipe(
    Stream.runFoldEffect([] as ReadonlyArray<FailedResource>, (acc, chunk) =>
      Effect.sync(() => {
        let next = acc
        for (const { failed, cause } of chunk) {
          next = [...next, failed]
          handleFailureSetUpdated(next)
          handleNewFailureCause(cause)
        }
        return next
      })
    ),
    Effect.map((failed) => ({ failed, cancelled: false }))
  )

/**
 * Model the whole sync as one long, interruptible Effect on a single
 * fiber:
 *
 *   - `acquire`: build the `CollectorBridgeMessageHandler`, register its
 *     bridge tags in the coordinator's `Collector` slot, then dispatch
 *     `RequestSniffableWebView`. Register-before-dispatch guarantees the
 *     host's sniffer events land on the live handler.
 *   - The handler publishes each result onto its `requestSniffingResults` stream,
 *     which {@link processSniffResultsFromMailbox} reads directly. The drive stream pulls each
 *     result and, for a `Right` batch, hands it to the injected `persistResources`
 *     *inline* (awaited): the batch is settled by the time the step finishes, so
 *     there's no outstanding-write bookkeeping. The write requirement (`R`,
 *     the sink's environment) bubbles up to this Effect's `R`, which the
 *     broadened collector `runAuthed` satisfies.
 *   - Completion is the `requestSniffingResults` stream finishing: the handler
 *     closes it once `SniffingComplete` has fired and every sniffed request has
 *     settled, and {@link processSniffResultsFromMailbox} stops when a `take` sees it
 *     done+drained. {@link DEFAULT_IDLE_TIMEOUT} is the escape hatch for a silent
 *     host — on idle, `abandonAllRequestSniffing` fails any stalled request and
 *     closes the stream.
 *   - `release` (natural completion, idle settle, or explicit cancel via
 *     the run's `AbortSignal`): `cancelAllRequestSniffing` → `unregister`.
 *
 * `context` — the config's plan + `persistResources`, resource type hidden (a
 * {@link CollectorDescriptor.ResourcePersistenceContext}) — is injected, so the
 * runner is generic over the collector's `Resources` and its write requirement
 * `R`. This function is the one concrete
 * {@link CollectorDescriptor.ResourcePersistenceProgram}.
 */
const buildImportEffect = <Resources, R>({
  context: { scrapingPlan, persistResources },
  sendCollectorMessage,
  collectorRegister,
  onNewFailureCause: handleNewFailureCause,
  onFailureSetUpdated: handleFailureSetUpdated,
  idleTimeout,
}: {
  readonly context: CollectorDescriptor.ResourcePersistenceContext<Resources, R>
  readonly sendCollectorMessage: CollectorSender
  readonly collectorRegister: ReturnType<typeof useCollectorRegister>
  readonly onNewFailureCause: (error: unknown) => void
  readonly onFailureSetUpdated: (failed: ReadonlyArray<FailedResource>) => void
  /**
   * The caller's silent-host guard. **Wins over the plan's own
   * `ScrapingPlan.idleTimeout`** when supplied; `undefined` (the caller has no
   * opinion) falls through to the plan's, then to {@link DEFAULT_IDLE_TIMEOUT}.
   * Callers must therefore pass `undefined` rather than pre-defaulting, or the
   * plan's value can never take effect.
   */
  readonly idleTimeout: Duration.DurationInput | undefined
}): Effect.Effect<ImportSummary, never, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      // Fold one response outcome into the drive step's failure data. The sink
      // owns the retry/backoff schedule, the per-resource span, and concurrency;
      // the runner owns only the batch `collector.importing` span (resource
      // count) and folding failures into the summary. Null-id handling lives in
      // the sink (a skipped resource contributes no failure), so the runner
      // stays resource-agnostic. `Right` a decoded batch → persist; `Left` a
      // response-level failure → one `PersistFailure` keyed on the URL.
      const processSniffResult = (
        event: SniffResult<Resources>
      ): Effect.Effect<ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R> =>
        Either.match(event, {
          onRight: (resources) =>
            persistResources(resources).pipe(
              Effect.withSpan(Telemetry.Importing.Span.Name, {
                attributes: {
                  [Telemetry.Importing.Span.Attributes.ResourceCount]: resources.length,
                },
              })
            ),
          onLeft: ({ error, url }) =>
            Effect.succeed<ReadonlyArray<CollectorDescriptor.PersistFailure>>([
              { failed: { label: 'response', id: url }, cause: error },
            ]),
        })

      // The handler observes its own `SniffingComplete` internally (the step
      // machine's terminal dispatch runs the lifecycle's `handleSniffingComplete`
      // hook, which closes `requestSniffingResults`), so the runner passes the
      // plain sender — no completion wrap needed here.
      const { requestSniffingResults: sniffResultMailbox, abandonAllRequestSniffing } =
        yield* Effect.acquireRelease(
          Effect.gen(function* () {
            // Separate out the `pipeThroughHandlers` bridge tags so the handler's
            // `incompleteSniffedRequests` / `requestSniffingResults` /
            // `abandonAllRequestSniffing` / `cancelAllRequestSniffing` don't leak
            // into the transport's tag→handler map.
            const {
              incompleteSniffedRequests,
              requestSniffingResults,
              abandonAllRequestSniffing: handlerAbandonAll,
              cancelAllRequestSniffing,
              ...pipeThroughHandlers
            } = yield* CollectorBridgeMessageHandler.make<Resources>({
              scrapingPlan,
              sendMessage: sendCollectorMessage,
            })

            yield* collectorRegister
              .register(pipeThroughHandlers)
              .pipe(
                Effect.catchAll((error) =>
                  Effect.logError('useSyncRunner: handler registration failed', error)
                )
              )
            // Captured inside the `Sync` span (see `Effect.withSpan` below),
            // so the sniffer can link its per-page root traces back to this
            // run's trace.
            const linkedSpan = yield* captureLinkedSpan
            yield* sendCollectorMessage(
              linkedSpan === undefined
                ? { _tag: 'RequestSniffableWebView', source: scrapingPlan.firstPage }
                : { _tag: 'RequestSniffableWebView', source: scrapingPlan.firstPage, linkedSpan }
            ).pipe(
              Effect.catchAllCause((cause) =>
                Effect.logError('useSyncRunner: failed to dispatch RequestSniffableWebView', cause)
              )
            )
            return {
              incompleteSniffedRequests,
              requestSniffingResults,
              abandonAllRequestSniffing: handlerAbandonAll,
              cancelAllRequestSniffing,
              pipeThroughHandlers,
            }
          }),
          ({ cancelAllRequestSniffing, pipeThroughHandlers }) =>
            cancelAllRequestSniffing(sendCollectorMessage).pipe(
              Effect.andThen(
                collectorRegister
                  .unregister(pipeThroughHandlers)
                  .pipe(
                    Effect.catchAll((error) =>
                      Effect.logError('useSyncRunner: handler unregistration failed', error)
                    )
                  )
              )
            )
        )

      const persistFailureStream = processSniffResultsFromMailbox({
        sniffResultMailbox,
        processSniffResult,
        onIdleTimeout: abandonAllRequestSniffing,
        idleTimeout: resolveIdleTimeout(idleTimeout, scrapingPlan.idleTimeout),
      })
      // Idle-timeout escape: `abandonAllRequestSniffing` publishes every
      // still-incomplete sniffed request as a `Left` failure on
      // `requestSniffingResults` and closes the stream, so a stalled download
      // (whose `ResponseData` chunks never produce a terminal) is reported as a
      // loss instead of hanging the run. The drive loop reads
      // `requestSniffingResults` directly (completion is that stream finishing)
      // and drains those failures — they flow through `processSniffResult` like
      // any other failure — then observes `done`.
      return yield* collectImportSummary(
        persistFailureStream,
        handleFailureSetUpdated,
        handleNewFailureCause
      )
    })
  ).pipe(
    // Record how the run ended as a permanent attribute on the `Sync` span:
    // a clean success vs a cancelled/interrupted teardown. `onExit` is applied
    // *inside* `withSpan` (before it in the pipe), so `annotateCurrentSpan`
    // targets the `Sync` span while it is still the active span — annotating
    // after `withSpan` would tag the parent span instead.
    Effect.onExit((exit) =>
      Effect.annotateCurrentSpan(
        Telemetry.Sync.Attributes.Outcome,
        exit._tag === 'Success' ? 'clean' : 'cancelled'
      )
    ),
    Effect.withSpan(Telemetry.Sync.Span.Name, {})
  )

export {
  processSniffResultsFromMailbox,
  buildImportEffect,
  collectImportSummary,
  DEFAULT_IDLE_TIMEOUT,
  resolveIdleTimeout,
}
export type { FailedResource, ImportSummary, SniffResult }
