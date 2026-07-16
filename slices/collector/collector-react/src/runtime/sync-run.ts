/**
 * The framework-free core of the collector sync runner: the mailbox
 * drive loop, quiescence / idle-timeout logic, and per-resource write
 * retries. Extracted from `use-sync-runner.ts` so it is unit-testable
 * with `TestClock` (no React Testing Library) and so the persistence sink
 * (3B of epic #382) is a focused injection into this file.
 *
 * This module has **no React imports** — the hook (`use-sync-runner.ts`)
 * owns the mutation wiring, the `AbortController`, and the `RunnerState`
 * mapping, and injects the two React-facing callbacks (`setFailed` /
 * `onError`) as plain functions. The only reference to a hook here is a
 * type-only import of `useCollectorRegister` (erased at runtime) so the
 * injected `collectorRegister` stays exactly typed.
 *
 * The runner is **fully generic** over a collector's resource type
 * (`Resources`) and its write requirement (`R`): where it used to
 * `switch (resource.resourceType)` over FHIR endpoints, it now calls the
 * injected `persistResource` sink and labels telemetry / failures through
 * `describeResource`. Both come from the owning `CollectorDescriptor` via
 * the registry's existential `runIngredients` bundle, so this file no
 * longer names any collector's resource union (retiring
 * `AnyCollectorResource`) and no longer imports the FHIR client. The
 * runner still owns everything *around* a write — batching,
 * `WRITE_CONCURRENCY`, the retry/backoff schedule, spans, and failure
 * accounting.
 *
 * The drive loop is expressed as a small explicit state machine — a
 * {@link RunPhase} tagged union plus the pure {@link driveTransition} —
 * mirroring the browser-sniffer step machine's "tagged-union state + a
 * pure `(state, input) → [state, effects]` transition" shape, without its
 * full six-file ceremony (see `collector-fundamentals`'s
 * `handler/step-machine/`). The mutable run facts live in {@link RunStore}.
 */
import { CollectorBridgeMessageHandler } from 'collector-fundamentals/handler'
import type { CollectorDescriptor, ScrapingPlan } from 'collector-fundamentals/model'
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
  Schedule,
} from 'effect'

import { captureLinkedSpan } from './capture-linked-span.ts'
import type { CollectorSender } from './collector-sender-context.ts'
import type { useCollectorRegister } from './use-collector-register.ts'

/**
 * Identifier of an upsert that failed after all retries (or a response
 * that failed to parse). Surfaced via the `partial` runner state so the
 * UI can render "N of M synced". `label` / `id` are the descriptor's
 * {@link CollectorDescriptor.ResourceDescription} — the runner never
 * inspects a resource's fields itself.
 */
interface FailedResource {
  readonly label: string
  readonly id: string
}

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
 * handler's `onResult` pushes `parsed` / `failure` synchronously; the
 * sender wrap pushes `sniffDone` when the step machine dispatches its
 * terminal `SniffingComplete`, both to wake the loop and to flip the
 * completion signal. There is no per-write event: writes are awaited
 * inline (see {@link buildImportEffect}), so the loop needs no write
 * bookkeeping.
 */
type ImportEvent<Resources> =
  | { readonly _tag: 'parsed'; readonly resources: ReadonlyArray<Resources> }
  | { readonly _tag: 'failure'; readonly error: unknown; readonly url: string }
  | { readonly _tag: 'sniffDone' }

/** Stalled-host guard window when the caller doesn't override it. */
const DEFAULT_IDLE_TIMEOUT: Duration.DurationInput = Duration.seconds(30)

/**
 * Grace window for the completion check. The handler now drops a response's
 * id from `inProgressResponses` only *after* it offers the terminal
 * `parsed`/`failure` event, so a "quiescent" observation can no longer
 * precede the event that still needs a write — the parse→offer race is
 * closed structurally in `CollectorBridgeMessageHandler`. This window
 * remains a small belt-and-suspenders re-confirm: after quiescence first
 * holds we wait this long for a straggler before terminating, so a late
 * sniffer event (e.g. a `ResponseStart` that hasn't re-populated tracking
 * yet) still gets a chance to land.
 */
const SHORT_CONFIRM_WINDOW: Duration.DurationInput = Duration.millis(250)

/**
 * TEMPORARY tunable (investigation): max concurrent resource PUTs within a
 * single `writeBatch`. Unbounded concurrency fired hundreds of simultaneous
 * upserts that stalled the inline-awaited drive loop, so the `Sync` span
 * never ended and never flushed. Capped at 1 while we confirm the writes
 * resolve/time out; widen once the stall is understood.
 */
const WRITE_CONCURRENCY = 1

/**
 * The run's mutable state behind one named surface. It owns the event
 * mailbox plus the two facts that decide completion — whether sniffing
 * dispatched its terminal step, and the accumulated failures — and
 * exposes {@link RunStore.isSettled} as the single place that answers
 * "are we done?". Writes are *not* tracked here: the drive loop awaits
 * each batch inline, so a processed event leaves its writes already
 * settled.
 *
 * This is a state *store* (a bag of mutable refs + a mailbox), deliberately
 * distinct from the drive loop's {@link RunPhase} state *machine*: the store
 * holds the facts, the machine decides transitions from them.
 */
interface RunStore<Resources> {
  /** Push a decoded response's resources (sync; called from `onResult`). */
  readonly offerParsed: (resources: ReadonlyArray<Resources>) => void
  /** Push a parse/transport failure (sync; called from `onResult`). */
  readonly offerFailure: (error: unknown, url: string) => void
  /** Mark sniffing finished and wake the loop (the sender wrap calls this). */
  readonly signalSniffComplete: Effect.Effect<void>
  /** Next event, or `None` once `window` elapses with nothing queued. */
  readonly tryTakeEvent: (
    window: Duration.DurationInput
  ) => Effect.Effect<Option.Option<ImportEvent<Resources>>>
  /** Record a failed item: drives `partial` state and fires `onError` once. */
  readonly handleFailure: (failed: FailedResource, error: unknown) => Effect.Effect<void>
  /** Sniffing finished, no response mid-stream, no event queued. */
  readonly isSettled: (
    inProgressResponses: MutableHashMap.MutableHashMap<string, unknown>
  ) => Effect.Effect<boolean>
  /** Summary to resolve the mutation with (always `cancelled: false` here). */
  readonly summary: Effect.Effect<ImportSummary>
}

const makeRunStore = <Resources>(
  setFailed: (failed: ReadonlyArray<FailedResource>) => void,
  onError: (error: unknown) => void
): Effect.Effect<RunStore<Resources>> =>
  Effect.gen(function* () {
    const events = yield* Mailbox.make<ImportEvent<Resources>>()
    const sniffComplete = yield* Ref.make(false)
    const failures = yield* Ref.make<ReadonlyArray<FailedResource>>([])

    const handleFailure: RunStore<Resources>['handleFailure'] = (failed, error) =>
      Ref.updateAndGet(failures, (arr) => [...arr, failed]).pipe(
        Effect.flatMap((arr) =>
          Effect.sync(() => {
            setFailed(arr)
            onError(error)
          })
        )
      )

    const isSettled: RunStore<Resources>['isSettled'] = (inProgressResponses) =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(sniffComplete))) return false
        if (MutableHashMap.size(inProgressResponses) > 0) return false
        const queued = yield* events.size
        return Option.match(queued, { onNone: () => true, onSome: (n) => n === 0 })
      })

    return {
      offerParsed: (resources) => {
        events.unsafeOffer({ _tag: 'parsed', resources })
      },
      offerFailure: (error, url) => {
        events.unsafeOffer({ _tag: 'failure', error, url })
      },
      signalSniffComplete: Ref.set(sniffComplete, true).pipe(
        Effect.andThen(events.offer({ _tag: 'sniffDone' })),
        Effect.asVoid
      ),
      tryTakeEvent: (window) =>
        events.take.pipe(
          Effect.timeoutOption(window),
          Effect.catchTag('NoSuchElementException', () => Effect.succeedNone)
        ),
      handleFailure,
      isSettled,
      summary: Ref.get(failures).pipe(Effect.map((failed) => ({ failed, cancelled: false }))),
    }
  })

/**
 * The drive loop's phase — an explicit, named state, mirroring the
 * browser-sniffer step machine's tagged-union-state shape.
 *
 * - `Draining`: still importing. The loop waits the long `idleTimeout` for
 *   the next event; a quiet window here means the host may have stalled.
 * - `Confirming`: quiescence has held once (`isSettled`). The loop waits the
 *   short `SHORT_CONFIRM_WINDOW` to let a straggler land before terminating.
 * - `Terminated`: the loop is done; the runtime stops.
 *
 * The phase is re-derived from `isSettled` at the top of every iteration, so
 * `Draining` / `Confirming` name *which wait we are in*; `Terminated` is the
 * one phase the transition commits to.
 */
type RunPhase =
  | { readonly _tag: 'Draining' }
  | { readonly _tag: 'Confirming' }
  | { readonly _tag: 'Terminated' }

const draining: RunPhase = { _tag: 'Draining' }
const confirming: RunPhase = { _tag: 'Confirming' }
const terminated: RunPhase = { _tag: 'Terminated' }

/**
 * What one wait resolved to — the pure transition's input. The runtime
 * ({@link buildImportEffect}'s drive loop) performs the effectful reads
 * (`tryTakeEvent`, a re-check of `isSettled`, the in-flight count) to build
 * this, so {@link driveTransition} itself stays a pure
 * `(phase, observation) → [phase, effects]`.
 *
 * - `Event`: an event was pulled from the mailbox.
 * - `QuiescenceHeld`: the short window elapsed and `isSettled` still holds —
 *   the run is genuinely complete.
 * - `QuiescenceLost`: the short window elapsed but `isSettled` no longer
 *   holds (a late event landed) — go back to draining.
 * - `IdleQuiet`: the long window elapsed with nothing tracked in-flight — the
 *   host has gone silent; terminate.
 * - `IdleStragglers`: the long window elapsed with responses still mid-stream
 *   (their `ResponseData` chunks don't wake the loop) — settle them as
 *   failures, then terminate.
 */
type DriveObservation<Resources> =
  | { readonly _tag: 'Event'; readonly event: ImportEvent<Resources> }
  | { readonly _tag: 'QuiescenceHeld' }
  | { readonly _tag: 'QuiescenceLost' }
  | { readonly _tag: 'IdleQuiet' }
  | { readonly _tag: 'IdleStragglers' }

/**
 * The effects {@link driveTransition} can request, as data — the runtime
 * discharges them (mirrors the step machine's "the transition names effects,
 * it never executes them").
 *
 * - `ProcessEvent`: handle a pulled event (write a batch / record a failure).
 * - `SettleStragglers`: warn about, then record as failures, every response
 *   still in-flight at the idle timeout.
 */
type DriveEffect<Resources> =
  | { readonly _tag: 'ProcessEvent'; readonly event: ImportEvent<Resources> }
  | { readonly _tag: 'SettleStragglers' }

/**
 * The pure drive-loop transition: `(phase, observation) → [phase, effects]`.
 * No `Effect`, no clock — it only names what should happen next; the runtime
 * interprets the effects and loops until `Terminated`.
 *
 * On `Event` the current `phase` is passed through (the next iteration
 * re-derives `Draining` / `Confirming` from `isSettled`); the quiescence /
 * idle observations are the ones that commit to `Terminated` (or fold back to
 * `Draining` when quiescence was lost).
 */
const driveTransition = <Resources>(
  phase: RunPhase,
  observation: DriveObservation<Resources>
): readonly [RunPhase, ReadonlyArray<DriveEffect<Resources>>] =>
  Match.value(observation).pipe(
    Match.withReturnType<readonly [RunPhase, ReadonlyArray<DriveEffect<Resources>>]>(),
    Match.tag('Event', ({ event }) => [phase, [{ _tag: 'ProcessEvent', event }]]),
    Match.tag('QuiescenceHeld', () => [terminated, []]),
    Match.tag('QuiescenceLost', () => [draining, []]),
    Match.tag('IdleQuiet', () => [terminated, []]),
    Match.tag('IdleStragglers', () => [terminated, [{ _tag: 'SettleStragglers' }]]),
    Match.exhaustive
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
 *     {@link RunStore} mailbox. The drive loop pulls each event and, for
 *     `parsed`, upserts the batch *inline* (`Effect.forEach`, awaited): the
 *     batch is settled by the time the event finishes, so there's no
 *     outstanding-write bookkeeping. The write requirement (`R`, the
 *     descriptor's `persistResource` environment) bubbles up to this
 *     Effect's `R`, which the broadened collector `runAuthed` satisfies.
 *   - Completion is {@link RunStore.isSettled} — sniffing dispatched its
 *     terminal step, no response is mid-stream, the mailbox is empty —
 *     re-confirmed across {@link SHORT_CONFIRM_WINDOW}. The handler keeps a
 *     response tracked until *after* its `parsed`/`failure` event is offered
 *     (see {@link SHORT_CONFIRM_WINDOW}), so quiescence can't be observed while
 *     a parse→offer is still outstanding. {@link DEFAULT_IDLE_TIMEOUT} is the
 *     escape hatch for a silent host.
 *   - `release` (natural completion, idle settle, or explicit cancel via
 *     the run's `AbortSignal`): `cancelAllInFlight` → `clear` → `unregister`.
 *
 * `persistResource` (where a write goes) and `describeResource` (its
 * telemetry / failure label) are injected — the runner is generic over the
 * collector's `Resources` and its write requirement `R`.
 */
const buildImportEffect = <Resources, R>({
  scrapingPlan,
  persistResource,
  describeResource,
  sendCollectorMessage,
  collectorRegister,
  onError,
  setFailed,
  idleTimeout,
}: {
  readonly scrapingPlan: ScrapingPlan.ScrapingPlan<Resources>
  readonly persistResource: (resource: Resources) => Effect.Effect<void, unknown, R>
  readonly describeResource: (resource: Resources) => CollectorDescriptor.ResourceDescription
  readonly sendCollectorMessage: CollectorSender
  readonly collectorRegister: ReturnType<typeof useCollectorRegister>
  readonly onError: (error: unknown) => void
  readonly setFailed: (failed: ReadonlyArray<FailedResource>) => void
  readonly idleTimeout: Duration.DurationInput
}): Effect.Effect<ImportSummary, never, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* makeRunStore<Resources>(setFailed, onError)

      // One resource's write, retried with bounded exponential backoff (3
      // retries, 250ms → 1s). Each attempt is its own span, so the retry
      // count reads straight off the trace — no counter needed.
      // `Schedule.intersect` enforces both "stop after N" AND "exponential";
      // `either` would stop on whichever fired first. "Which write goes
      // where" is the injected `persistResource`; the runner owns the
      // schedule, the span, and the failure recording around it.
      const writeResourceWithRetries = (resource: Resources): Effect.Effect<void, never, R> => {
        const { label, id } = describeResource(resource)
        return persistResource(resource).pipe(
          Effect.tapError((err) =>
            Effect.logError(`sync-run: upsert failed for ${label}/${id}`, err)
          ),
          Effect.retry(
            Schedule.exponential('250 millis').pipe(Schedule.intersect(Schedule.recurs(3)))
          ),
          Effect.withSpan(Telemetry.Importing.Update.Span.Name, {
            attributes: { [Telemetry.Importing.Update.Span.Attributes.Kind]: label },
          }),
          Effect.asVoid,
          // Retries exhausted: record + notify, but don't fail the run.
          Effect.catchAll((err) => store.handleFailure({ label, id }, err))
        )
      }

      // Upsert a decoded response's resources — concurrent within the
      // batch, awaited as a whole so the drive loop blocks until they
      // settle. `discard` because failures are recorded inside
      // `writeResourceWithRetries`; nothing flows back. Null-id handling
      // lives in the descriptor's `persistResource` (a skipped resource
      // resolves cleanly), so the runner stays resource-agnostic.
      const writeBatch = (resources: ReadonlyArray<Resources>): Effect.Effect<void, never, R> =>
        Effect.forEach(
          resources,
          (resource) => {
            const { label, id } = describeResource(resource)
            return Effect.andThen(
              Effect.logDebug(`sync-run: upserting ${label}/${id}`),
              writeResourceWithRetries(resource)
            )
          },
          { concurrency: WRITE_CONCURRENCY, discard: true }
        ).pipe(
          Effect.withSpan(Telemetry.Importing.Span.Name, {
            attributes: { [Telemetry.Importing.Span.Attributes.ResourceCount]: resources.length },
          })
        )

      const processStateEvent = (event: ImportEvent<Resources>): Effect.Effect<void, never, R> =>
        Match.value(event).pipe(
          Match.tag('parsed', ({ resources }) => writeBatch(resources)),
          Match.tag('failure', ({ error, url }) =>
            store.handleFailure({ label: 'response', id: url }, error)
          ),
          // Wake-only: `signalSniffComplete` already flipped the flag.
          Match.tag('sniffDone', () => Effect.void),
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
                onLeft: (error) => store.offerFailure(error, response.url),
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

      // Idle-timeout escape hatch when responses are still mid-stream.
      // `ResponseData` chunks don't produce a mailbox event, so a large/slow
      // download still streaming after `idleTimeout` would otherwise be
      // silently abandoned by a hard terminate. Instead, settle every still
      // tracked id as a failure (surfacing them in the `partial` summary) so
      // the run reports the loss rather than dropping it on the floor.
      const settleInFlightAsFailures: Effect.Effect<void> = Effect.suspend(() =>
        Effect.forEach(
          MutableHashMap.values(inProgressBridgeResponses),
          ({ response }) =>
            store.handleFailure(
              { label: 'response', id: response.url },
              new Error(
                `useSyncRunner: response for ${response.url} still in-flight at idle timeout; abandoning`
              )
            ),
          { discard: true }
        )
      )

      // Discharge one effect named by {@link driveTransition}.
      const runDriveEffect = (effect: DriveEffect<Resources>): Effect.Effect<void, never, R> =>
        Match.value(effect).pipe(
          Match.withReturnType<Effect.Effect<void, never, R>>(),
          Match.tag('ProcessEvent', ({ event }) => processStateEvent(event)),
          Match.tag('SettleStragglers', () =>
            Effect.logWarning(
              `useSyncRunner: idle timeout with ${MutableHashMap.size(
                inProgressBridgeResponses
              )} response(s) still in-flight; settling as failures`
            ).pipe(Effect.andThen(settleInFlightAsFailures))
          ),
          Match.exhaustive
        )

      // Gather one wait's {@link DriveObservation}, doing the effectful reads
      // (`isSettled` re-check, in-flight count) so {@link driveTransition}
      // stays pure. `settledBeforeListening` fixes which observations are
      // reachable: after a short (`Confirming`) wait we re-confirm quiescence;
      // after a long (`Draining`) wait we inspect the in-flight set.
      const observe = (
        settledBeforeListening: boolean,
        event: Option.Option<ImportEvent<Resources>>
      ): Effect.Effect<DriveObservation<Resources>> =>
        Option.match(event, {
          onSome: (taken) =>
            Effect.succeed<DriveObservation<Resources>>({ _tag: 'Event', event: taken }),
          onNone: () =>
            settledBeforeListening
              ? store
                  .isSettled(inProgressBridgeResponses)
                  .pipe(
                    Effect.map(
                      (stillSettled): DriveObservation<Resources> =>
                        stillSettled ? { _tag: 'QuiescenceHeld' } : { _tag: 'QuiescenceLost' }
                    )
                  )
              : Effect.succeed<DriveObservation<Resources>>(
                  MutableHashMap.size(inProgressBridgeResponses) === 0
                    ? { _tag: 'IdleQuiet' }
                    : { _tag: 'IdleStragglers' }
                ),
        })

      // The drive loop as an explicit state machine: derive the phase from
      // settledness, wait the phase's window, observe, run the pure
      // transition, discharge its effects, repeat until `Terminated`.
      yield* Effect.gen(function* () {
        let phase: RunPhase = draining
        while (phase._tag !== 'Terminated') {
          const settledBeforeListening = yield* store.isSettled(inProgressBridgeResponses)
          phase = settledBeforeListening ? confirming : draining
          const window = settledBeforeListening ? SHORT_CONFIRM_WINDOW : idleTimeout
          const event = yield* store.tryTakeEvent(window)
          const observation = yield* observe(settledBeforeListening, event)
          const [nextPhase, effects] = driveTransition(phase, observation)
          yield* Effect.forEach(effects, runDriveEffect, { discard: true })
          phase = nextPhase
          yield* Effect.logDebug(
            `useSyncRunner: drive loop — observation=${observation._tag} nextPhase=${nextPhase._tag}`
          )
        }
      })

      return yield* store.summary
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
  buildImportEffect,
  DEFAULT_IDLE_TIMEOUT,
  driveTransition,
  makeRunStore,
  SHORT_CONFIRM_WINDOW,
  WRITE_CONCURRENCY,
}
export type {
  DriveEffect,
  DriveObservation,
  FailedResource,
  ImportEvent,
  ImportSummary,
  RunPhase,
  RunStore,
}
