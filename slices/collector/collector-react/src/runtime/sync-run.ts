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
 * emits one chunk of failures per drive step, and {@link collectImportSummary}
 * runs the fold. The drive step is a plain decision table — **not** an FSM
 * (unlike the browser-sniffer automatic-navigation machine, which models concurrent,
 * interruptible timers; this does not). Completion is not computed here: it is
 * the handler's `requestSniffingResults` stream finishing (the handler closes it
 * at sniff-complete + drained) — see the timeline in
 * `collector-fundamentals/docs/Collector Sync Explanation.md`.
 *
 * There is **no runner-side idle guard**: a plan bounds its own run through its
 * step holds' `timeout`s (a stalled or silent host is caught by whichever hold
 * is parked), so timing lives entirely in the plan rather than in a rolling
 * timer here.
 */
import { CollectorBridgeMessageHandler } from 'collector-fundamentals/handler'
import type { CollectorDescriptor } from 'collector-fundamentals/model'
import * as Telemetry from 'collector-fundamentals/telemetry'
import type { Mailbox } from 'effect'
import { Effect, Either, Option, Stream } from 'effect'

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

/**
 * The drive loop as a `Stream` over the handler's read-only results mailbox
 * (passed as `sniffResultMailbox`). **Completion is folded into that mailbox** — the
 * handler `end`s it once sniffing is complete and every response has settled —
 * so "are we done?" is simply "has the mailbox finished draining?" There is no
 * separate quiescence check here: no sniff-complete signal and no
 * in-flight-response map live in the runner, and no idle timer — a plan bounds
 * itself through its step holds' `timeout`s. Failures are not stored either —
 * each step emits its batch's failures as data and {@link collectImportSummary}
 * accumulates them; a processed event leaves its writes already settled (the
 * step awaits each batch inline).
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
 *
 * `sniffResultMailbox` and `processSniffResult` are injected so this stays a
 * small, testable unit independent of the bridge handler. Generic over the
 * collector's `Resources` and the write requirement `R`.
 */
const processSniffResultsFromMailbox = <Resources, R>({
  sniffResultMailbox,
  processSniffResult,
}: {
  readonly sniffResultMailbox: Mailbox.ReadonlyMailbox<SniffResult<Resources>>
  readonly processSniffResult: (
    event: SniffResult<Resources>
  ) => Effect.Effect<ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R>
}): Stream.Stream<ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R> =>
  Stream.paginateEffect<void, ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R>(
    undefined,
    () =>
      sniffResultMailbox.take.pipe(
        Effect.flatMap(
          (
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
            )
        ),
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
 * Fold one response outcome into the drive step's failure data. The sink owns
 * the retry/backoff schedule, the per-resource span, and concurrency; the
 * runner owns only the batch `collector.importing` span (resource count) and
 * folding failures into the summary. Null-id handling lives in the sink (a
 * skipped resource contributes no failure), so the runner stays
 * resource-agnostic. `Right` a decoded {@link SniffedBatch} → persist; `Left`
 * a response-level failure → one `PersistFailure` keyed on the URL.
 *
 * On the `Right` side the batch's two channels get different accounting:
 *
 * - `resources` — the primary output — is written first, so a diagnostic write
 *   can never delay (let alone displace) a clinical one, and its failures are
 *   returned. An empty batch makes no call at all.
 * - `diagnostics` ride the *same* sink — never a re-derived write — but their
 *   failures stop here: WARN-logged by `label`/`id` and kept out of the
 *   returned failures, so `collectImportSummary` never folds a failed
 *   *diagnostic* write into `RunnerState: 'partial'` or the caller's
 *   `onError`. A record about the run must not degrade the run it records.
 */
const makeProcessSniffResult =
  <Resources, R>(
    persistResources: CollectorDescriptor.ResourcePersistenceContext<
      Resources,
      R
    >['persistResources']
  ) =>
  (
    event: SniffResult<Resources>
  ): Effect.Effect<ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R> =>
    Either.match(event, {
      onRight: ({ resources, diagnostics }) =>
        Effect.gen(function* () {
          const failures =
            resources.length === 0
              ? []
              : yield* persistResources(resources).pipe(
                  Effect.withSpan(Telemetry.Importing.Span.Name, {
                    attributes: {
                      [Telemetry.Importing.Span.Attributes.ResourceCount]: resources.length,
                    },
                  })
                )
          if (diagnostics.length > 0) {
            const diagnosticFailures = yield* persistResources(diagnostics)
            yield* Effect.forEach(
              diagnosticFailures,
              ({ failed, cause }) =>
                Effect.logWarning(
                  `sync-run: diagnostic ${failed.label} ${failed.id} was not written; the run is unaffected`,
                  cause
                ),
              { discard: true }
            )
          }
          return failures
        }),
      onLeft: ({ error, url }) =>
        Effect.succeed<ReadonlyArray<CollectorDescriptor.PersistFailure>>([
          { failed: { label: 'response', id: url }, cause: error },
        ]),
    })

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
 *     done+drained. There is no runner-side idle guard — a plan bounds its own
 *     run through its step holds' `timeout`s (the terminal `AwaitPageSettled`
 *     `timeout`, an `AwaitUserDismiss` `timeout`, …).
 *   - `release` (natural completion or explicit cancel via the run's
 *     `AbortSignal`): `cancelAllRequestSniffing` → `unregister`.
 *
 * `context` — the config's plan + `persistResources`, resource type hidden (a
 * {@link CollectorDescriptor.ResourcePersistenceContext}) — is injected, so the
 * runner is generic over the collector's `Resources` and its write requirement
 * `R`. This function is the one concrete
 * {@link CollectorDescriptor.ResourcePersistenceProgram}.
 */
const buildImportEffect = <Resources, R>({
  context: { scrapingPlan, persistResources, runId },
  sendCollectorMessage,
  collectorRegister,
  onNewFailureCause: handleNewFailureCause,
  onFailureSetUpdated: handleFailureSetUpdated,
}: {
  readonly context: CollectorDescriptor.ResourcePersistenceContext<Resources, R>
  readonly sendCollectorMessage: CollectorSender
  readonly collectorRegister: ReturnType<typeof useCollectorRegister>
  readonly onNewFailureCause: (error: unknown) => void
  readonly onFailureSetUpdated: (failed: ReadonlyArray<FailedResource>) => void
}): Effect.Effect<ImportSummary, never, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const processSniffResult = makeProcessSniffResult(persistResources)

      // The handler observes its own `SniffingComplete` internally (the step
      // machine's terminal dispatch runs the lifecycle's `handleSniffingComplete`
      // hook, which closes `requestSniffingResults`), so the runner passes the
      // plain sender — no completion wrap needed here.
      const { requestSniffingResults: sniffResultMailbox } = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          // Separate the handler's four control surfaces off the
          // `pipeThroughHandlers` bridge tags so they don't leak into the
          // transport's tag→handler map. Only `requestSniffingResults` (the drive
          // loop's mailbox) and `cancelAllRequestSniffing` (the release) are
          // consumed; `incompleteSniffedRequests` and `abandonAllRequestSniffing`
          // are excluded-only — nothing drives them now that the idle guard is
          // gone — so they are destructured to `_`-prefixed throwaways.
          const {
            incompleteSniffedRequests: _incompleteSniffedRequests,
            requestSniffingResults,
            abandonAllRequestSniffing: _abandonAllRequestSniffing,
            cancelAllRequestSniffing,
            ...pipeThroughHandlers
          } = yield* CollectorBridgeMessageHandler.make<Resources>({
            scrapingPlan,
            sendMessage: sendCollectorMessage,
            runId,
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
          // No starting page: the host mounts the sniffer on `about:blank` and
          // the plan navigates from there with its leading `Open` step.
          yield* sendCollectorMessage(
            linkedSpan === undefined
              ? { _tag: 'RequestSniffableWebView' }
              : { _tag: 'RequestSniffableWebView', linkedSpan }
          ).pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError('useSyncRunner: failed to dispatch RequestSniffableWebView', cause)
            )
          )
          return {
            requestSniffingResults,
            cancelAllRequestSniffing,
            pipeThroughHandlers,
          }
        }),
        ({ cancelAllRequestSniffing, pipeThroughHandlers }) =>
          // Scope close: tell the host to stop sniffing, then unregister the
          // bridge handlers so a later sniffer event can't hit a dropped receiver.
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
      })
      // The drive loop reads `requestSniffingResults` directly — completion is
      // that stream finishing (queue drained ∧ every sniffed request settled),
      // with no idle backstop. A plan bounds itself through its step holds'
      // `timeout`s.
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
  makeProcessSniffResult,
}
export type { FailedResource, ImportSummary, SniffResult }
