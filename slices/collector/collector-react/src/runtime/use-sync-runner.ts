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
import type { Remote as CollectorRemote } from 'collector-core/livestore'
import { makeScrapingPlanForConfig, type AnyCollectorResource } from 'collector-core/registry'
import { CollectorBridgeMessageHandler } from 'collector-fundamentals/handler'
import { Effect, Either, Schedule } from 'effect'
import { useFhirR4ResourcesEffectRunner } from 'fhir-r4-react'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useCollectorRuntime } from './use-collector-runtime.ts'
import { useCollectorSender } from './use-collector-sender.ts'

/**
 * Identifier of an upsert that failed after all retries. Surfaced via
 * the `partial` runner state so the UI can render "N of M synced".
 */
interface FailedResource {
  readonly resourceType: string
  readonly id: string
}

/**
 * What the screen passes in: which collector `remote` row is being
 * synced and an optional error notifier (parse failures, transport
 * errors). The remote's `config` is the typed `CollectorConfig` union
 * already (livestore decoded it on read), so no extra decode here.
 */
interface SyncRunnerInput {
  readonly remote: CollectorRemote.RemoteRow
  readonly onError?: (error: unknown) => void
}

type RunnerState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'running' }
  | { readonly _tag: 'partial'; readonly failed: ReadonlyArray<FailedResource> }
  | { readonly _tag: 'errored'; readonly error: unknown }

/**
 * Hook that wires a single sync run to the active-handler ref on
 * `<CollectorRuntimeProvider>`:
 *
 *   - Builds the per-config `RemoteKind` via
 *     `makeRemoteForConfig(remote.config)`.
 *   - Constructs a `CollectorBridgeMessageHandler` whose `onResult`
 *     PUTs parsed resources to the local FHIR R4 server via
 *     `FhirR4ResourcesHttpApiClient`. Each PUT is retried with a
 *     bounded exponential schedule (3 attempts, 250ms → 1s); the
 *     `onError` callback fires only after retries are exhausted.
 *   - Installs the handler into the runtime ref on mount; dispatches
 *     `CancelSnifferRequest` for every in-flight id, then clears the
 *     handler's state and uninstalls it on unmount.
 *
 * The hook does *not* fire `RequestSniffableWebView` — that's the
 * screen's job via `useRequestSniffableWebView`. The runner just
 * receives events and routes the parsed output.
 *
 * Callback identity (`onError`) is stored in a ref so a fresh lambda
 * from a parent re-render doesn't tear down the handler and lose
 * `inProgressResponses`. The effect's dep array is narrowed to the
 * inputs that materially change the handler (`remote.id`,
 * `remote.config`, `sendCollectorMessage`, `setActiveHandler`,
 * `runFhir`).
 */
const useSyncRunner = ({ remote, onError }: SyncRunnerInput): RunnerState => {
  const { setActiveHandler } = useCollectorRuntime()
  const sendCollectorMessage = useCollectorSender()
  const runFhir = useFhirR4ResourcesEffectRunner()
  const [state, setState] = useState<RunnerState>({ _tag: 'idle' })

  // Stash `onError` in a ref so a parent passing a fresh lambda on
  // every render doesn't trigger the main effect (which would rebuild
  // the handler and drop `inProgressResponses`).
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // Accumulates resources whose upsert failed after retries — surfaced
  // via the `partial` runner state.
  const failedRef = useRef<FailedResource[]>([])

  // Memoise the scraping plan so re-renders that don't change `config`
  // don't rebuild the handler. Keyed on `remote.config` identity, which
  // is stable across livestore reads of the same row.
  const scrapingPlan = useMemo(() => makeScrapingPlanForConfig(remote.config), [remote.config])

  useEffect(() => {
    const handleParsedResource = (resource: AnyCollectorResource): void => {
      // Entities filter out null-id resources before emitting (see
      // `PatientEntity` etc.); narrow defensively for the typed `path`.
      if (resource.id === null) return
      const path = { id: resource.id }
      const upsert = Effect.gen(function* () {
        const client = yield* FhirR4ResourcesHttpApiClient
        switch (resource.resourceType) {
          case 'Patient': {
            return yield* client.Patient.Update({ path, payload: { ...resource, id: path.id } })
          }
          case 'Observation': {
            return yield* client.Observation.Update({ path, payload: { ...resource, id: path.id } })
          }
          case 'Binary': {
            return yield* client.Binary.Update({ path, payload: { ...resource, id: path.id } })
          }
          default: {
            // `AnyCollectorResource` is `Patient | Observation | Binary`. A
            // new collector that widens the union without a matching case
            // here is a compile error via the `never`-typed exhaustive
            // assignment.
            const exhaustive: never = resource
            return yield* Effect.dieMessage(
              `useSyncRunner: unknown resourceType ${String(exhaustive)}`
            )
          }
        }
      })

      // Bounded retry: up to 3 retries with exponential backoff starting
      // at 250ms. `Schedule.intersect` enforces "stop after N attempts"
      // AND "exponential" — `Schedule.either` would stop on whichever
      // schedule chose first, which is the wrong semantics.
      const upsertWithRetry = upsert.pipe(
        Effect.retry(
          Schedule.exponential('250 millis').pipe(Schedule.intersect(Schedule.recurs(3)))
        ),
        Effect.tapError((err) =>
          Effect.logError(
            `useSyncRunner: upsert failed for ${resource.resourceType}/${path.id}`,
            err
          )
        )
      )

      runFhir(upsertWithRetry).catch((err: unknown) => {
        failedRef.current = [
          ...failedRef.current,
          { resourceType: resource.resourceType, id: path.id },
        ]
        setState({ _tag: 'partial', failed: failedRef.current })
        // Backward-compatibility: keep firing `onError` once retries
        // are exhausted so existing callers still see the failure.
        onErrorRef.current?.(err)
      })
    }

    const handler = CollectorBridgeMessageHandler.make<AnyCollectorResource>({
      scrapingPlan,
      sendMessage: sendCollectorMessage,
      onResult: ({ result }) =>
        Either.match(result, {
          onLeft: (err) => {
            setState({ _tag: 'errored', error: err })
            onErrorRef.current?.(err)
          },
          onRight: (parsed) => {
            for (const resource of parsed) handleParsedResource(resource)
          },
        }),
    })

    setActiveHandler(handler)
    setState({ _tag: 'running' })

    return (): void => {
      // Tell the page to stop streaming bytes for any in-flight ids
      // before we drop the local tracking state — otherwise the host
      // keeps emitting `ResponseData` that the runtime provider would
      // log-and-drop. Cleanup is synchronous, so we `runFork` the
      // cancel-dispatch Effect and proceed to clear immediately.
      Effect.runFork(handler.cancelAllInFlight(sendCollectorMessage))
      handler.clear()
      setActiveHandler(null)
    }
  }, [remote.id, scrapingPlan, sendCollectorMessage, setActiveHandler, runFhir])

  return state
}

export { useSyncRunner }
export type { FailedResource, RunnerState, SyncRunnerInput }
