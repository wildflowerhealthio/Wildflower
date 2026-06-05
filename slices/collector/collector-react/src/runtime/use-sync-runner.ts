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
import type { Remote as CollectorRemote } from 'collector-core/livestore'
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
  type Scope,
} from 'effect'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from '../queries/use-run-authed.ts'
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
 * retries). `idleTimeout` is the stalled-host guard: if no terminal
 * sniffer event or write settles within the window the run settles
 * anyway, so a silent host can't pin the mutation in `pending` forever.
 */
interface SyncRunnerInput {
  readonly onError?: (error: unknown) => void
  readonly idleTimeout?: Duration.DurationInput
}

type RunnerState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'running' }
  | { readonly _tag: 'partial'; readonly failed: ReadonlyArray<FailedResource> }
  | { readonly _tag: 'errored'; readonly error: unknown }
  | { readonly _tag: 'done' }

/** Imperative surface the screen drives the runner through. */
interface SyncRunner {
  readonly state: RunnerState
  readonly startImport: (remote: CollectorRemote.RemoteRow) => void
  readonly cancel: () => void
}

/**
 * Internal events the inbound bridge handler pushes (synchronously, via
 * `Mailbox.unsafeOffer`) for the in-context consume loop to pull. The
 * loop forks FHIR writes for `parsed`, records `failure`s, notes the
 * terminal `sniffDone`, and treats `writeSettled` as a wake-up to
 * re-check completion promptly rather than waiting out a timeout.
 */
type ImportEvent =
  | { readonly _tag: 'parsed'; readonly resources: ReadonlyArray<AnyCollectorResource> }
  | { readonly _tag: 'failure'; readonly error: unknown; readonly url: string }
  | { readonly _tag: 'sniffDone' }
  | { readonly _tag: 'writeSettled' }

/** Stalled-host guard window when the caller doesn't override it. */
const DEFAULT_IDLE_TIMEOUT: Duration.DurationInput = Duration.seconds(30)

/**
 * Grace window for the completion check. `ResponseFinished` removes the
 * id from `inProgressResponses` *before* it offers the `parsed` event,
 * so a "drained" observation can momentarily precede the event that
 * still needs a write. After the drained condition holds we wait this
 * long for a straggler; only a quiet window confirms completion.
 */
const CONFIRM_WINDOW: Duration.DurationInput = Duration.millis(250)

/**
 * Model the whole sync as one long, interruptible Effect:
 *
 *   - `acquire`: build the `CollectorBridgeMessageHandler`, register its
 *     bridge tags in the coordinator's `Collector` slot, then dispatch
 *     `RequestSniffableWebView`. Register-before-dispatch guarantees the
 *     host's sniffer events land on the live handler.
 *   - The handler's `onResult` pushes parsed resources / failures into a
 *     `Mailbox`. A consume loop pulls them and `forkScoped`s each FHIR
 *     write so the writes inherit this Effect's runner-provided context
 *     (`FhirR4ResourcesHttpApiClient` + tracer) and are interrupted with
 *     the scope. The write requirement bubbles up to this Effect's `R`,
 *     which the broadened collector `runAuthed` satisfies.
 *   - Completion is the composite signal the loop watches: the step
 *     machine reached `Done` (it dispatched `SniffingComplete`),
 *     `inProgressResponses` drained, and every forked write settled —
 *     confirmed against {@link CONFIRM_WINDOW}. {@link DEFAULT_IDLE_TIMEOUT}
 *     is the escape hatch for a silent host.
 *   - `release` (natural completion, idle settle, or explicit cancel via
 *     the run's `AbortSignal`): `cancelAllInFlight` → `clear` →
 *     set-if-equal `unregister`.
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
      const events = yield* Mailbox.make<ImportEvent>()
      const sniffDoneRef = yield* Ref.make(false)
      const outstandingRef = yield* Ref.make(0)
      const failuresRef = yield* Ref.make<ReadonlyArray<FailedResource>>([])

      // Append a failure and surface it: drives the `partial` state and
      // fires `onError` once (parity with the pre-mutation runner).
      const recordFailure = (failed: FailedResource, error: unknown): Effect.Effect<void> =>
        Ref.updateAndGet(failuresRef, (arr) => [...arr, failed]).pipe(
          Effect.flatMap((arr) =>
            Effect.sync(() => {
              setFailed(arr)
              onErrorRef.current?.(error)
            })
          )
        )

      // One resource's PUT, retried with bounded exponential backoff (3
      // retries, 250ms → 1s). `Schedule.intersect` enforces both "stop
      // after N" AND "exponential"; `either` would stop on whichever
      // fired first. A `Ref` counts attempts for the outer span.
      const writeOne = (
        resource: AnyCollectorResource,
        id: string
      ): Effect.Effect<void, never, FhirR4ResourcesHttpApiClient> => {
        const path = { id }
        const upsert = Effect.gen(function* () {
          const client = yield* FhirR4ResourcesHttpApiClient
          switch (resource.resourceType) {
            case 'Patient': {
              return yield* client.Patient.Update({ path, payload: { ...resource, id } })
            }
            case 'Observation': {
              return yield* client.Observation.Update({ path, payload: { ...resource, id } })
            }
            case 'Binary': {
              return yield* client.Binary.Update({ path, payload: { ...resource, id } })
            }
            default: {
              const exhaustive: never = resource
              return yield* Effect.dieMessage(
                `useSyncRunner: unknown resourceType ${String(exhaustive)}`
              )
            }
          }
        })

        const upsertWithRetry = Effect.gen(function* () {
          const attempts = yield* Ref.make(0)
          const oneAttempt = Ref.update(attempts, (n) => n + 1).pipe(
            Effect.zipRight(
              upsert.pipe(
                Effect.withSpan(Telemetry.Importing.Update.Attempt.Span.Name, {
                  attributes: {
                    [Telemetry.Importing.Update.Attempt.Span.Attributes.Method]: 'PUT',
                    [Telemetry.Importing.Attributes.ResourceType]: resource.resourceType,
                  },
                })
              )
            )
          )
          return yield* oneAttempt.pipe(
            Effect.retry(
              Schedule.exponential('250 millis').pipe(Schedule.intersect(Schedule.recurs(3)))
            ),
            Effect.tapError((err) =>
              Effect.logError(
                `useSyncRunner: upsert failed for ${resource.resourceType}/${id}`,
                err
              )
            ),
            Effect.onExit(() =>
              Ref.get(attempts).pipe(
                Effect.flatMap((n) =>
                  Effect.annotateCurrentSpan(Telemetry.Importing.Update.Span.Attributes.Attempts, n)
                )
              )
            ),
            Effect.withSpan(Telemetry.Importing.Update.Span.Name, {
              attributes: { [Telemetry.Importing.Attributes.ResourceType]: resource.resourceType },
            })
          )
        })

        return upsertWithRetry.pipe(
          // Retries exhausted: record + notify, but don't fail the run.
          // Interruption (scope close) isn't a typed failure, so a
          // cancelled write skips this and just runs the finalizer.
          Effect.catchAll((err) => recordFailure({ resourceType: resource.resourceType, id }, err)),
          Effect.asVoid,
          // Always: drop the outstanding count and wake the loop so it
          // re-checks completion without waiting out a timeout.
          Effect.ensuring(
            Ref.update(outstandingRef, (n) => n - 1).pipe(
              Effect.andThen(events.offer({ _tag: 'writeSettled' }))
            )
          )
        )
      }

      // Fork one parsed response's resources out as independent writes.
      // The batch span times the dispatch loop only; each write nests
      // under its own spans on the forked fiber.
      const forkWrites = (
        resources: ReadonlyArray<AnyCollectorResource>
      ): Effect.Effect<void, never, FhirR4ResourcesHttpApiClient | Scope.Scope> =>
        Effect.gen(function* () {
          for (const resource of resources) {
            // Entities filter null-id resources before emitting; narrow
            // defensively for the typed `path`.
            if (resource.id === null) continue
            yield* Ref.update(outstandingRef, (n) => n + 1)
            yield* Effect.forkScoped(writeOne(resource, resource.id))
          }
        }).pipe(
          Effect.withSpan(Telemetry.Importing.Span.Name, {
            attributes: {
              [Telemetry.Importing.Span.Attributes.ResourceCount]: resources.length,
            },
          })
        )

      const process = (
        event: ImportEvent
      ): Effect.Effect<void, never, FhirR4ResourcesHttpApiClient | Scope.Scope> => {
        switch (event._tag) {
          case 'sniffDone':
            return Ref.set(sniffDoneRef, true)
          case 'parsed':
            return forkWrites(event.resources)
          case 'failure':
            return recordFailure({ resourceType: 'response', id: event.url }, event.error)
          case 'writeSettled':
            return Effect.void
          default:
            return Effect.logError(
              `useSyncRunner: unknown event tag ${(event as { _tag: string })._tag}`
            )
        }
      }

      // Wrap the sender so dispatching the terminal `SniffingComplete`
      // (the step machine's last act) flips the loop's done signal —
      // "follow the steps and note the end" without touching the pure
      // handler. Everything else forwards verbatim.
      const observingSend = (
        message: CollectorBridgeMessageHandler.OutboundMessage
      ): Effect.Effect<void> =>
        message._tag === 'SniffingComplete'
          ? sendCollectorMessage(message).pipe(
              Effect.andThen(events.offer({ _tag: 'sniffDone' })),
              Effect.asVoid
            )
          : sendCollectorMessage(message)

      const { handler } = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const messageHandler = yield* CollectorBridgeMessageHandler.make<AnyCollectorResource>({
            scrapingPlan,
            sendMessage: observingSend,
            onResult: ({ response, result }) =>
              Either.match(result, {
                onLeft: (error) => {
                  events.unsafeOffer({ _tag: 'failure', error, url: response.url })
                },
                onRight: (resources) => {
                  events.unsafeOffer({ _tag: 'parsed', resources })
                },
              }),
          })
          // Register only the bridge tags so the handler's `clear` /
          // `cancelAllInFlight` don't leak into the transport's
          // tag→handler map.
          const messageHandlers = {
            ResponseStart: messageHandler.ResponseStart,
            ResponseData: messageHandler.ResponseData,
            ResponseFinished: messageHandler.ResponseFinished,
            RequestError: messageHandler.RequestError,
            Cancelled: messageHandler.Cancelled,
            PageLoaded: messageHandler.PageLoaded,
          }
          yield* collectorRegister
            .register(messageHandler)
            .pipe(
              Effect.catchAll((error) =>
                Effect.logError('useSyncRunner: handler registration failed', error)
              )
            )
          yield* sendCollectorMessage({
            _tag: 'RequestSniffableWebView',
            source: scrapingPlan.firstPage,
          }).pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError('useSyncRunner: failed to dispatch RequestSniffableWebView', cause)
            )
          )
          return { handler: messageHandler, handlers: messageHandlers }
        }),
        ({ handler: messageHandler, handlers: messageHandlers }) =>
          messageHandler
            .cancelAllInFlight(sendCollectorMessage)
            .pipe(
              Effect.andThen(messageHandler.clear()),
              Effect.andThen(
                collectorRegister
                  .unregister(messageHandlers)
                  .pipe(
                    Effect.catchAll((error) =>
                      Effect.logError('useSyncRunner: handler unregistration failed', error)
                    )
                  )
              )
            )
      )

      // The composite completion signal: sniffing finished, no tracked
      // response is mid-stream, and no forked write is outstanding.
      const isDrained: Effect.Effect<boolean> = Effect.gen(function* () {
        if (!(yield* Ref.get(sniffDoneRef))) return false
        if ((yield* Ref.get(outstandingRef)) > 0) return false
        return MutableHashMap.size(handler.inProgressResponses) === 0
      })

      const takeOption = (
        duration: Duration.DurationInput
      ): Effect.Effect<Option.Option<ImportEvent>> =>
        events.take.pipe(
          Effect.timeoutOption(duration),
          Effect.catchTag('NoSuchElementException', () => Effect.succeedNone)
        )

      // Once drained, keep pulling within CONFIRM_WINDOW until a quiet
      // window confirms it (absorbs the remove-before-offer reorder).
      const confirmDrained: Effect.Effect<
        boolean,
        never,
        FhirR4ResourcesHttpApiClient | Scope.Scope
      > = Effect.gen(function* () {
        while (true) {
          if (!(yield* isDrained)) return false
          const straggler = yield* takeOption(CONFIRM_WINDOW)
          if (Option.isNone(straggler)) return yield* isDrained
          yield* process(straggler.value)
        }
      })

      yield* Effect.gen(function* () {
        while (true) {
          const taken = yield* takeOption(idleTimeout)
          // Idle/hang guard: a silent window settles the run.
          if (Option.isNone(taken)) break
          yield* process(taken.value)
          if ((yield* isDrained) && (yield* confirmDrained)) break
        }
      })

      return { failed: yield* Ref.get(failuresRef), cancelled: false }
    })
  ).pipe(Effect.withSpan(Telemetry.Sync.Span.Name, {}))

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

  const mutation = useMutation<ImportSummary, Error, CollectorRemote.RemoteRow>({
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
    (remote: CollectorRemote.RemoteRow) => {
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
