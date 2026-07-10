/**
 * Slice-layering note: `collector-react` currently hard-couples to the
 * FHIR R4 EMR slice (`fhir-r4`, `fhir-r4-react`, `fhir-r4-client-collector`).
 * The sync runner POSTs parsed entities to `FhirR4ResourcesHttpApiClient`
 * directly — it doesn't know about other EMR targets. Adding a second
 * target (e.g. FHIR R5) means abstracting the resource-routing seam
 * below: most likely a runner-builder injected via a new context,
 * similar to how `<CollectorSenderForwarder>` wires the sender. The
 * coupling is documented as a deliberate slice-layering exception in
 * the `collector-react/package.json` description (per `slices/AGENTS.md`).
 */
import { useMutation } from '@tanstack/react-query'
import type { Remotes } from 'collector-core/http-api-definition'
import { makeScrapingPlanForConfig, type AnyCollectorResource } from 'collector-core/registry'
import { CollectorBridgeMessageHandler } from 'collector-fundamentals/handler'
import type { ScrapingPlan } from 'collector-fundamentals/model'
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
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from '../queries/use-run-authed.ts'
import { captureLinkedSpan } from './capture-linked-span.ts'
import type { CollectorSender } from './collector-sender-context.ts'
import { useCollectorRegister } from './use-collector-register.ts'
import { useCollectorSender } from './use-collector-sender.ts'

/**
 * Identifier of an upsert that failed after all retries (or a response
 * that failed to parse). Surfaced via the `partial` runner state so the
 * UI can render "N of M synced".
 */
interface FailedResource {
  readonly resourceType: string
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
 * Optional hook config. `onError` notifies the screen of parse/transport
 * failures and write-retry exhaustion (fired once per failed item, after
 * retries). `idleTimeout` is the stalled-host guard: if no sniffer event
 * arrives within the window the run settles anyway, so a silent host
 * can't pin the mutation in `pending` forever.
 */
interface SyncRunnerInput {
  readonly onError?: (error: unknown) => void
  readonly idleTimeout?: Duration.DurationInput
}

/** The wire shape of a configured remote, as served by `ListRemotes`. */
type CollectorRemote = typeof Remotes.RemoteSchema.Type

type RunnerState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'running' }
  | { readonly _tag: 'partial'; readonly failed: ReadonlyArray<FailedResource> }
  | { readonly _tag: 'errored'; readonly error: unknown }
  | { readonly _tag: 'done' }

/** Imperative surface the screen drives the runner through. */
interface SyncRunner {
  readonly state: RunnerState
  readonly startImport: (remote: CollectorRemote) => void
  readonly cancel: () => void
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
type ImportEvent =
  | { readonly _tag: 'parsed'; readonly resources: ReadonlyArray<AnyCollectorResource> }
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
 * exposes {@link RunStateMachine.isSettled} as the single place that
 * answers "are we done?". Writes are *not* tracked here: the drive loop
 * awaits each batch inline, so a processed event leaves its writes
 * already settled.
 */
interface RunStateMachine {
  /** Push a decoded response's resources (sync; called from `onResult`). */
  readonly offerParsed: (resources: ReadonlyArray<AnyCollectorResource>) => void
  /** Push a parse/transport failure (sync; called from `onResult`). */
  readonly offerFailure: (error: unknown, url: string) => void
  /** Mark sniffing finished and wake the loop (the sender wrap calls this). */
  readonly signalSniffComplete: Effect.Effect<void>
  /** Next event, or `None` once `window` elapses with nothing queued. */
  readonly tryTakeEvent: (
    window: Duration.DurationInput
  ) => Effect.Effect<Option.Option<ImportEvent>>
  /** Record a failed item: drives `partial` state and fires `onError` once. */
  readonly handleFailure: (failed: FailedResource, error: unknown) => Effect.Effect<void>
  /** Sniffing finished, no response mid-stream, no event queued. */
  readonly isSettled: (
    inProgressResponses: MutableHashMap.MutableHashMap<string, unknown>
  ) => Effect.Effect<boolean>
  /** Summary to resolve the mutation with (always `cancelled: false` here). */
  readonly summary: Effect.Effect<ImportSummary>
}

const makeRunStateMachine = (
  setFailed: (failed: ReadonlyArray<FailedResource>) => void,
  onErrorRef: { readonly current: ((error: unknown) => void) | undefined }
): Effect.Effect<RunStateMachine> =>
  Effect.gen(function* () {
    const events = yield* Mailbox.make<ImportEvent>()
    const sniffComplete = yield* Ref.make(false)
    const failures = yield* Ref.make<ReadonlyArray<FailedResource>>([])

    const handleFailure: RunStateMachine['handleFailure'] = (failed, error) =>
      Ref.updateAndGet(failures, (arr) => [...arr, failed]).pipe(
        Effect.flatMap((arr) =>
          Effect.sync(() => {
            setFailed(arr)
            onErrorRef.current?.(error)
          })
        )
      )

    const isSettled: RunStateMachine['isSettled'] = (inProgressResponses) =>
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
 * Model the whole sync as one long, interruptible Effect on a single
 * fiber:
 *
 *   - `acquire`: build the `CollectorBridgeMessageHandler`, register its
 *     bridge tags in the coordinator's `Collector` slot, then dispatch
 *     `RequestSniffableWebView`. Register-before-dispatch guarantees the
 *     host's sniffer events land on the live handler.
 *   - The handler's `onResult` pushes parsed resources / failures into the
 *     {@link RunStateMachine} mailbox. The drive loop pulls each event and, for
 *     `parsed`, upserts the batch *inline* (`Effect.forEach`, awaited): the
 *     batch is settled by the time the event finishes, so there's no
 *     outstanding-write bookkeeping. The write requirement bubbles up to
 *     this Effect's `R`, which the broadened collector `runAuthed` satisfies.
 *   - Completion is {@link RunStateMachine.isSettled} — sniffing dispatched
 *     its terminal step, no response is mid-stream, the mailbox is empty —
 *     re-confirmed across {@link SHORT_CONFIRM_WINDOW}. The handler keeps a
 *     response tracked until *after* its `parsed`/`failure` event is offered
 *     (see {@link SHORT_CONFIRM_WINDOW}), so quiescence can't be observed while
 *     a parse→offer is still outstanding. {@link DEFAULT_IDLE_TIMEOUT} is the
 *     escape hatch for a silent host.
 *   - `release` (natural completion, idle settle, or explicit cancel via
 *     the run's `AbortSignal`): `cancelAllInFlight` → `clear` → `unregister`.
 */
const buildImportEffect = ({
  scrapingPlan,
  sendCollectorMessage,
  collectorRegister,
  onErrorRef,
  setFailed,
  idleTimeout,
}: {
  readonly scrapingPlan: ScrapingPlan.ScrapingPlan<AnyCollectorResource>
  readonly sendCollectorMessage: CollectorSender
  readonly collectorRegister: ReturnType<typeof useCollectorRegister>
  readonly onErrorRef: { readonly current: ((error: unknown) => void) | undefined }
  readonly setFailed: (failed: ReadonlyArray<FailedResource>) => void
  readonly idleTimeout: Duration.DurationInput
}): Effect.Effect<ImportSummary, never, FhirR4ResourcesHttpApiClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      const stateMachine = yield* makeRunStateMachine(setFailed, onErrorRef)

      // One resource's PUT, retried with bounded exponential backoff (3
      // retries, 250ms → 1s). Each attempt is its own `PUT` span, so the
      // retry count reads straight off the trace — no counter needed.
      // `Schedule.intersect` enforces both "stop after N" AND "exponential";
      // `either` would stop on whichever fired first.
      const writeResourceWithRetries = (
        resource: AnyCollectorResource,
        id: string
      ): Effect.Effect<void, never, FhirR4ResourcesHttpApiClient> =>
        Effect.gen(function* () {
          const client = yield* FhirR4ResourcesHttpApiClient
          const path = { id }
          switch (resource.resourceType) {
            case 'Patient':
              return yield* client.Patient.Update({ path, payload: { ...resource, id } })
            case 'Observation':
              return yield* client.Observation.Update({ path, payload: { ...resource, id } })
            case 'Binary':
              return yield* client.Binary.Update({ path, payload: { ...resource, id } })
            default: {
              const unreachable: never = resource
              return yield* Effect.dieMessage(
                `useSyncRunner: unknown resourceType ${String(unreachable)}`
              )
            }
          }
        }).pipe(
          Effect.tapError((err) =>
            Effect.logError(`useSyncRunner: upsert failed for ${resource.resourceType}/${id}`, err)
          ),
          Effect.retry(
            Schedule.exponential('250 millis').pipe(Schedule.intersect(Schedule.recurs(3)))
          ),
          Effect.withSpan(Telemetry.Importing.Update.Span.Name, {
            attributes: { [Telemetry.FhirResource.Attributes.Type]: resource.resourceType },
          }),
          Effect.asVoid,
          // Retries exhausted: record + notify, but don't fail the run.
          Effect.catchAll((err) =>
            stateMachine.handleFailure({ resourceType: resource.resourceType, id }, err)
          )
        )

      // Upsert a decoded response's resources — concurrent within the
      // batch, awaited as a whole so the drive loop blocks until they
      // settle. `discard` because failures are recorded inside
      // `writeResourceWithRetries`; nothing flows back.
      const writeBatch = (
        resources: ReadonlyArray<AnyCollectorResource>
      ): Effect.Effect<void, never, FhirR4ResourcesHttpApiClient> =>
        Effect.forEach(
          resources,
          // Entities filter null-id resources before emitting; narrow
          // defensively for the typed `path`.
          (resource) =>
            resource.id === null
              ? Effect.logWarning(`useSyncRunner: skipping resource with null id`)
              : Effect.andThen(
                  Effect.logDebug(
                    `useSyncRunner: upserting ${resource.resourceType}/${resource.id}`
                  ),
                  writeResourceWithRetries(resource, resource.id)
                ),
          { concurrency: WRITE_CONCURRENCY, discard: true }
        ).pipe(
          Effect.withSpan(Telemetry.Importing.Span.Name, {
            attributes: { [Telemetry.Importing.Span.Attributes.ResourceCount]: resources.length },
          })
        )

      const processStateEvent = (
        event: ImportEvent
      ): Effect.Effect<void, never, FhirR4ResourcesHttpApiClient> =>
        Match.value(event).pipe(
          Match.tag('parsed', ({ resources }) => writeBatch(resources)),
          Match.tag('failure', ({ error, url }) =>
            stateMachine.handleFailure({ resourceType: 'response', id: url }, error)
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
          ? sendCollectorMessage(message).pipe(Effect.andThen(stateMachine.signalSniffComplete))
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
          } = yield* CollectorBridgeMessageHandler.make<AnyCollectorResource>({
            scrapingPlan,
            sendMessage: observingSend,
            onResult: ({ response, result }) =>
              Either.match(result, {
                onLeft: (error) => stateMachine.offerFailure(error, response.url),
                onRight: (resources) => stateMachine.offerParsed(resources),
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
            stateMachine.handleFailure(
              { resourceType: 'response', id: response.url },
              new Error(
                `useSyncRunner: response for ${response.url} still in-flight at idle timeout; abandoning`
              )
            ),
          { discard: true }
        )
      )

      yield* Effect.gen(function* () {
        while (true) {
          const currentlySettled = yield* stateMachine.isSettled(inProgressBridgeResponses)
          const waitDuration = currentlySettled ? SHORT_CONFIRM_WINDOW : idleTimeout
          const event = yield* stateMachine.tryTakeEvent(waitDuration)

          const shouldTerminate = yield* Match.value({
            event,
            settledBeforeListening: currentlySettled,
          }).pipe(
            Match.withReturnType<Effect.Effect<boolean, never, FhirR4ResourcesHttpApiClient>>(),
            Match.when({ event: Option.isSome }, ({ event: { value: takenEvent } }) =>
              processStateEvent(takenEvent).pipe(Effect.as(false))
            ),
            // Confirm things remained settled after SHORT_CONFIRM_WINDOW
            Match.when({ event: Option.isNone, settledBeforeListening: true }, () =>
              stateMachine.isSettled(inProgressBridgeResponses)
            ),
            // We waited the long `idleTimeout` with no mailbox event. If
            // nothing is tracked, the host has gone quiet — terminate. But a
            // response can still be mid-stream here (chunks don't wake the
            // loop), so only terminate when `inProgressResponses` is empty;
            // otherwise warn and settle the stalled responses as failures so
            // they surface in `partial`, then terminate.
            Match.when({ event: Option.isNone, settledBeforeListening: false }, () =>
              MutableHashMap.size(inProgressBridgeResponses) === 0
                ? Effect.succeed(true)
                : Effect.logWarning(
                    `useSyncRunner: idle timeout with ${MutableHashMap.size(
                      inProgressBridgeResponses
                    )} response(s) still in-flight; settling as failures`
                  ).pipe(Effect.andThen(settleInFlightAsFailures), Effect.as(true))
            ),
            Match.orElse(() =>
              Effect.logError('useSyncRunner: unexpected match case in drive loop').pipe(
                Effect.as(true)
              )
            )
          )

          yield* Effect.logDebug(
            `useSyncRunner: drive loop iteration — event=${Option.match(event, {
              onNone: () => 'none',
              onSome: (e) => e._tag,
            })} settledBeforeListening=${currentlySettled} shouldTerminate=${shouldTerminate}`
          )

          if (shouldTerminate) {
            break
          }
        }
      })

      return yield* stateMachine.summary
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

/**
 * Drives a single collector sync as a TanStack triggered mutation over
 * one long, interruptible Effect (see {@link buildImportEffect}). The
 * screen calls {@link SyncRunner.startImport} from its "Import Now"
 * action and reads {@link SyncRunner.state} for the banner;
 * {@link SyncRunner.cancel} aborts the in-flight run.
 *
 * Lifecycle maps onto the mutation: `pending` → `running` (or `partial`
 * once any write/parse failed), `success` → `done` (or `partial`), and
 * a rejected run → `errored`. An explicit cancel resolves cleanly and
 * maps back to `idle`. There is no unmount→interrupt wiring: a run is
 * left to finish (or settle via the idle guard); all teardown lives in
 * the Effect's `release`.
 */
const useSyncRunner = ({
  onError,
  idleTimeout = DEFAULT_IDLE_TIMEOUT,
}: SyncRunnerInput = {}): SyncRunner => {
  const sendCollectorMessage = useCollectorSender()
  const collectorRegister = useCollectorRegister()
  const runAuthed = useRunAuthed()

  // Stash `onError` in a ref so a parent passing a fresh lambda each
  // render doesn't re-key the mutation's closure.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // Live failure list, surfaced via `partial`. Reset at each start.
  const [failed, setFailed] = useState<ReadonlyArray<FailedResource>>([])

  // Per-run AbortController so `cancel()` can interrupt the long Effect.
  const abortRef = useRef<AbortController | null>(null)

  const mutation = useMutation<ImportSummary, Error, CollectorRemote>({
    mutationFn: (remote) => {
      const controller = new AbortController()
      abortRef.current = controller
      const scrapingPlan = makeScrapingPlanForConfig(remote.config)
      const importEffect = buildImportEffect({
        scrapingPlan,
        sendCollectorMessage,
        collectorRegister,
        onErrorRef,
        setFailed,
        idleTimeout,
      })
      return runAuthed(importEffect, { signal: controller.signal }).catch((error: unknown) => {
        // An explicit cancel surfaces as an interruption rejection;
        // resolve cleanly so the mutation lands on `idle`, not `error`.
        if (controller.signal.aborted) return { failed: [], cancelled: true }
        throw error
      })
    },
  })

  const { mutate } = mutation
  const startImport = useCallback(
    (remote: CollectorRemote) => {
      setFailed([])
      mutate(remote)
    },
    [mutate]
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const state: RunnerState = Match.value(mutation).pipe(
    Match.when({ status: 'error' }, ({ error }): RunnerState => ({ _tag: 'errored', error })),
    Match.when(
      { status: 'pending' },
      (): RunnerState => (failed.length > 0 ? { _tag: 'partial', failed } : { _tag: 'running' })
    ),
    Match.when(
      { status: 'success', data: { cancelled: true } },
      (): RunnerState => ({ _tag: 'idle' })
    ),
    Match.when(
      { status: 'success' },
      (): RunnerState => (failed.length > 0 ? { _tag: 'partial', failed } : { _tag: 'done' })
    ),
    Match.orElse((): RunnerState => ({ _tag: 'idle' }))
  )

  return { state, startImport, cancel }
}

export { useSyncRunner }
export type { FailedResource, RunnerState, SyncRunner, SyncRunnerInput }
