/**
 * The framework-free core of the collector sync runner: the event
 * {@link RunStore}, the drive {@link buildDriveStream} that turns the run's
 * events into a `Stream` of write outcomes, and {@link collectImportSummary}
 * that folds that stream into the {@link ImportSummary}. Extracted from
 * `use-sync-runner.ts` so it is unit-testable with `TestClock` (no React
 * Testing Library).
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
 * The run's output is **produced by a `Stream`**: {@link buildDriveStream}
 * emits one chunk of failures per drive step (via `Stream.paginateEffect`, so
 * the terminal step can still emit — the idle-timeout straggler settle), and
 * {@link collectImportSummary} runs the fold. The drive step is a plain
 * decision table — **not** an FSM (unlike the browser-sniffer step machine,
 * which models concurrent, interruptible timers; this does not). Its one real
 * subtlety is the completion predicate — see the timeline in
 * `collector-fundamentals/docs/Collector Sync Explanation.md`.
 */
import { CollectorBridgeMessageHandler } from 'collector-fundamentals/handler'
import type { CollectorDescriptor } from 'collector-fundamentals/model'
import * as Telemetry from 'collector-fundamentals/telemetry'
import {
  Duration,
  Effect,
  Either,
  Mailbox,
  Match,
  MutableHashMap,
  Option,
  Ref,
  Stream,
} from 'effect'

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
 * Internal events the inbound bridge handler feeds the drive loop. The
 * handler's `onResult` pushes `parsed` / `responseFailure` synchronously; the
 * sender wrap pushes `sniffDone` when the step machine dispatches its terminal
 * `SniffingComplete`, both to wake the loop and to flip the completion signal.
 * There is no per-write event: a batch's writes are awaited inside the drive
 * step, so the loop needs no write bookkeeping. `responseFailure` is a
 * *response-level* parse/transport failure (keyed on the response URL),
 * distinct from a resource's write failure (which the persist sink reports).
 */
type RunEvent<Resources> =
  | { readonly _tag: 'parsed'; readonly resources: ReadonlyArray<Resources> }
  | { readonly _tag: 'responseFailure'; readonly error: unknown; readonly url: string }
  | { readonly _tag: 'sniffDone' }

/** Stalled-host guard window when the caller doesn't override it. */
const DEFAULT_IDLE_TIMEOUT: Duration.DurationInput = Duration.seconds(30)

/**
 * Grace window for the completion check. The handler now drops a response's
 * id from `inProgressResponses` only *after* it offers the terminal
 * `parsed`/`responseFailure` event, so a "quiescent" observation can no longer
 * precede the event that still needs a write — the parse→offer race is
 * closed structurally in `CollectorBridgeMessageHandler`. This window
 * remains a small belt-and-suspenders re-confirm: after quiescence first
 * holds we wait this long for a straggler before terminating, so a late
 * sniffer event (e.g. a `ResponseStart` that hasn't re-populated tracking
 * yet) still gets a chance to land.
 */
const SHORT_CONFIRM_WINDOW: Duration.DurationInput = Duration.millis(250)

/**
 * The run's mutable state behind one named surface: the event mailbox plus the
 * one fact — whether sniffing dispatched its terminal step — that, together
 * with the mailbox and the caller's in-flight-response map, decides completion.
 * {@link RunStore.isSettled} is the single place that answers "are we done?".
 *
 * This is purely the *event source + completion facts*. Failures are **not**
 * stored here: the drive stream carries each batch's failures as data and
 * {@link collectImportSummary} accumulates them. Writes are not tracked either:
 * the drive step awaits each batch inline, so a processed event leaves its
 * writes already settled.
 *
 * Constructed effectfully (it owns a `Mailbox` and a `Ref`), so instances come
 * from the {@link RunStore.make} factory. The private fields are the plumbing;
 * the public methods are the whole surface the handler and drive loop use.
 */
class RunStore<Resources> {
  private constructor(
    private readonly events: Mailbox.Mailbox<RunEvent<Resources>>,
    private readonly sniffComplete: Ref.Ref<boolean>
  ) {}

  static make<Resources>(): Effect.Effect<RunStore<Resources>> {
    return Effect.gen(function* () {
      const events = yield* Mailbox.make<RunEvent<Resources>>()
      const sniffComplete = yield* Ref.make(false)
      return new RunStore<Resources>(events, sniffComplete)
    })
  }

  /** Push a decoded response's resources (sync; called from `onResult`). */
  offerParsed(resources: ReadonlyArray<Resources>): void {
    this.events.unsafeOffer({ _tag: 'parsed', resources })
  }

  /** Push a response-level parse/transport failure (sync; from `onResult`). */
  offerResponseFailure(error: unknown, url: string): void {
    this.events.unsafeOffer({ _tag: 'responseFailure', error, url })
  }

  /** Mark sniffing finished and wake the loop (the sender wrap calls this). */
  get signalSniffComplete(): Effect.Effect<void> {
    return Ref.set(this.sniffComplete, true).pipe(
      Effect.andThen(this.events.offer({ _tag: 'sniffDone' })),
      Effect.asVoid
    )
  }

  /** Next event, or `None` once `window` elapses with nothing queued. */
  tryTakeEvent(window: Duration.DurationInput): Effect.Effect<Option.Option<RunEvent<Resources>>> {
    return this.events.take.pipe(
      Effect.timeoutOption(window),
      Effect.catchTag('NoSuchElementException', () => Effect.succeedNone)
    )
  }

  /** Sniffing finished, no response mid-stream, no event queued. */
  isSettled(
    inProgressResponses: MutableHashMap.MutableHashMap<string, unknown>
  ): Effect.Effect<boolean> {
    const { sniffComplete, events } = this
    return Effect.gen(function* () {
      if (!(yield* Ref.get(sniffComplete))) return false
      if (MutableHashMap.size(inProgressResponses) > 0) return false
      const queued = yield* events.size
      return Option.match(queued, { onNone: () => true, onSome: (n) => n === 0 })
    })
  }
}

/**
 * The drive loop as a `Stream`: each step waits for the next event or a
 * timeout, acts, and emits the chunk of {@link CollectorDescriptor.PersistFailure}
 * that step produced (empty when it wrote nothing), continuing until the run is
 * complete. `Stream.paginateEffect` is used precisely because it emits its
 * element on the *terminal* step too — that is how the idle-timeout straggler
 * settle reports its failures and ends the stream in one step. A plain decision
 * table, not a state machine, because there is no concurrent/interruptible
 * state to track (contrast the step machine's overlapping timers). The one real
 * subtlety is *when to stop*; the timeline is documented in
 * `collector-fundamentals/docs/Collector Sync Explanation.md`.
 *
 * Each step:
 * - If quiescence already holds (`isSettled`), wait only the short
 *   {@link SHORT_CONFIRM_WINDOW}; otherwise wait the long `idleTimeout`.
 * - An event pulled from the mailbox is processed (its failures emitted), then
 *   the loop continues.
 * - The window elapsing on an empty mailbox is a *decision point*:
 *   - was settled → re-confirm `isSettled` (a straggler may have landed): if
 *     it still holds, the run is complete; else keep draining;
 *   - not settled (idle timeout) → nothing in-flight means the host went
 *     silent, so stop; responses still mid-stream (their `ResponseData`
 *     chunks don't wake the loop) are settled as failures via
 *     `settleStragglers` — emitted on the terminal step — then the loop stops.
 *
 * Effectful reads (`isSettled`) and the actions (`processEvent`,
 * `settleStragglers`) are injected so this stays a small, `TestClock`-testable
 * unit independent of the bridge handler.
 */
const buildDriveStream = <Resources, R>({
  store,
  inProgressResponses,
  processEvent,
  settleStragglers,
  idleTimeout,
}: {
  readonly store: RunStore<Resources>
  readonly inProgressResponses: MutableHashMap.MutableHashMap<string, unknown>
  readonly processEvent: (
    event: RunEvent<Resources>
  ) => Effect.Effect<ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R>
  readonly settleStragglers: Effect.Effect<
    ReadonlyArray<CollectorDescriptor.PersistFailure>,
    never,
    R
  >
  readonly idleTimeout: Duration.DurationInput
}): Stream.Stream<ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R> =>
  Stream.paginateEffect<void, ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R>(
    undefined,
    () =>
      Effect.gen(function* () {
        const settled = yield* store.isSettled(inProgressResponses)
        const window = settled ? SHORT_CONFIRM_WINDOW : idleTimeout
        const event = yield* store.tryTakeEvent(window)
        if (Option.isSome(event)) {
          const produced = yield* processEvent(event.value)
          return [produced, Option.some<void>(undefined)] as const
        }
        // The window elapsed with an empty mailbox — decide whether to stop.
        if (settled) {
          // Re-confirm: a straggler could have re-entered during the wait.
          return (yield* store.isSettled(inProgressResponses))
            ? ([[], Option.none<void>()] as const)
            : ([[], Option.some<void>(undefined)] as const)
        }
        // Idle timeout while still draining.
        if (MutableHashMap.size(inProgressResponses) === 0) {
          return [[], Option.none<void>()] as const
        }
        const stragglers = yield* settleStragglers
        return [stragglers, Option.none<void>()] as const
      })
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
  setFailed: (failed: ReadonlyArray<FailedResource>) => void,
  onError: (cause: unknown) => void
): Effect.Effect<ImportSummary, never, R> =>
  failures.pipe(
    Stream.runFoldEffect([] as ReadonlyArray<FailedResource>, (acc, chunk) =>
      Effect.sync(() => {
        let next = acc
        for (const { failed, cause } of chunk) {
          next = [...next, failed]
          setFailed(next)
          onError(cause)
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
 *   - The handler's `onResult` pushes parsed resources / failures into the
 *     {@link RunStore} mailbox. The drive stream pulls each event and, for
 *     `parsed`, hands the batch to the injected `persistResources` *inline*
 *     (awaited): the batch is settled by the time the step finishes, so
 *     there's no outstanding-write bookkeeping. The write requirement (`R`,
 *     the sink's environment) bubbles up to this Effect's `R`, which the
 *     broadened collector `runAuthed` satisfies.
 *   - Completion is {@link RunStore.isSettled}, driven by
 *     {@link buildDriveStream} and re-confirmed across
 *     {@link SHORT_CONFIRM_WINDOW}. {@link DEFAULT_IDLE_TIMEOUT} is the escape
 *     hatch for a silent host.
 *   - `release` (natural completion, idle settle, or explicit cancel via
 *     the run's `AbortSignal`): `cancelAllInFlight` → `clear` → `unregister`.
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
  onError,
  setFailed,
  idleTimeout,
}: {
  readonly context: CollectorDescriptor.ResourcePersistenceContext<Resources, R>
  readonly sendCollectorMessage: CollectorSender
  readonly collectorRegister: ReturnType<typeof useCollectorRegister>
  readonly onError: (error: unknown) => void
  readonly setFailed: (failed: ReadonlyArray<FailedResource>) => void
  readonly idleTimeout: Duration.DurationInput
}): Effect.Effect<ImportSummary, never, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* RunStore.make<Resources>()

      // Persist a decoded batch, returning its failures as data. The sink owns
      // the retry/backoff schedule, the per-resource span, and concurrency;
      // the runner owns only the batch `collector.importing` span (resource
      // count) and folding the returned failures into the summary. Null-id
      // handling lives in the sink (a skipped resource contributes no failure),
      // so the runner stays resource-agnostic.
      const processStateEvent = (
        event: RunEvent<Resources>
      ): Effect.Effect<ReadonlyArray<CollectorDescriptor.PersistFailure>, never, R> =>
        Match.value(event).pipe(
          Match.tag('parsed', ({ resources }) =>
            persistResources(resources).pipe(
              Effect.withSpan(Telemetry.Importing.Span.Name, {
                attributes: {
                  [Telemetry.Importing.Span.Attributes.ResourceCount]: resources.length,
                },
              })
            )
          ),
          Match.tag('responseFailure', ({ error, url }) =>
            Effect.succeed<ReadonlyArray<CollectorDescriptor.PersistFailure>>([
              { failed: { label: 'response', id: url }, cause: error },
            ])
          ),
          // Wake-only: `signalSniffComplete` already flipped the flag.
          Match.tag('sniffDone', () =>
            Effect.succeed<ReadonlyArray<CollectorDescriptor.PersistFailure>>([])
          ),
          Match.exhaustive
        )

      // Wrap the sender so dispatching the terminal `SniffingComplete`
      // (the step machine's last act) flips the completion signal — "follow
      // the steps and note the end" without touching the pure handler.
      const observingSend = (
        message: CollectorBridgeMessageHandler.OutboundMessage
      ): Effect.Effect<void> =>
        message._tag === 'SniffingComplete'
          ? sendCollectorMessage(message).pipe(Effect.andThen(store.signalSniffComplete))
          : sendCollectorMessage(message)

      const { inProgressResponses: inProgressBridgeResponses } = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          // Separate out the `pipeThroughHandlers` bridge tags so the handler's
          //  `clear` / `cancelAllInFlight` don't leak into the transport's
          // tag→handler map.
          const {
            inProgressResponses,
            clear: clearMessageHandler,
            cancelAllInFlight,
            ...pipeThroughHandlers
          } = yield* CollectorBridgeMessageHandler.make<Resources>({
            scrapingPlan,
            sendMessage: observingSend,
            onResult: ({ response, result }) =>
              Either.match(result, {
                onLeft: (error) => store.offerResponseFailure(error, response.url),
                onRight: (resources) => store.offerParsed(resources),
              }),
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
            inProgressResponses,
            clearMessageHandler,
            cancelAllInFlight,
            pipeThroughHandlers,
          }
        }),
        ({ clearMessageHandler, cancelAllInFlight, pipeThroughHandlers }) =>
          cancelAllInFlight(sendCollectorMessage).pipe(
            Effect.andThen(clearMessageHandler()),
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

      // Idle-timeout straggler settle, prefixed with a warning naming how many
      // responses were abandoned. `ResponseData` chunks don't produce a mailbox
      // event, so a large/slow download still streaming after `idleTimeout`
      // would otherwise be silently abandoned by a hard terminate. Instead,
      // settle every still-tracked id as a failure (surfacing them in the
      // `partial` summary) so the run reports the loss rather than dropping it.
      // Returned as data (like a write failure) for the drive stream to emit.
      const settleStragglers: Effect.Effect<
        ReadonlyArray<CollectorDescriptor.PersistFailure>,
        never,
        R
      > = Effect.suspend(() => {
        const inflight = Array.from(MutableHashMap.values(inProgressBridgeResponses))
        return Effect.logWarning(
          `sync-run: idle timeout with ${inflight.length} response(s) still in-flight; settling as failures`
        ).pipe(
          Effect.as(
            inflight.map(({ response }) => ({
              failed: { label: 'response', id: response.url },
              cause: new Error(
                `useSyncRunner: response for ${response.url} still in-flight at idle timeout; abandoning`
              ),
            }))
          )
        )
      })

      return yield* collectImportSummary(
        buildDriveStream({
          store,
          inProgressResponses: inProgressBridgeResponses,
          processEvent: processStateEvent,
          settleStragglers,
          idleTimeout,
        }),
        setFailed,
        onError
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
  buildDriveStream,
  buildImportEffect,
  collectImportSummary,
  DEFAULT_IDLE_TIMEOUT,
  RunStore,
  SHORT_CONFIRM_WINDOW,
}
export type { FailedResource, ImportSummary, RunEvent }
