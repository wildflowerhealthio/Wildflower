import type { Remote as CollectorRemote } from 'collector-core/livestore'
import { makeRemoteForConfig, type AnyCollectorResource } from 'collector-core/registry'
import { CollectorBridgeMessageHandler } from 'collector-fundamentals/handler'
import { Effect, Either } from 'effect'
import { useFhirR4ResourcesEffectRunner } from 'fhir-r4-react'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { useCallback, useEffect, useState } from 'react'

import { useCollectorRuntime } from './use-collector-runtime.ts'
import { useCollectorSender } from './use-collector-sender.ts'

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
  | { readonly _tag: 'errored'; readonly error: unknown }

/**
 * Hook that wires a single sync run to the active-handler ref on
 * `<CollectorRuntimeProvider>`:
 *
 *   - Builds the per-config `RemoteKind` via
 *     `makeRemoteForConfig(remote.config)`.
 *   - Constructs a `CollectorBridgeMessageHandler` whose `onResult`
 *     PUTs parsed resources to the local FHIR R4 server via
 *     `FhirR4ResourcesHttpApiClient`.
 *   - Installs the handler into the runtime ref on mount; clears the
 *     handler's in-flight entries and uninstalls it on unmount.
 *
 * The hook does *not* fire `RequestSniffableWebView` — that's the
 * screen's job via `useRequestSniffableWebView`. The runner just
 * receives events and routes the parsed output.
 */
const useSyncRunner = ({ remote, onError }: SyncRunnerInput): RunnerState => {
  const { setActiveHandler } = useCollectorRuntime()
  const sendCollectorMessage = useCollectorSender()
  const runFhir = useFhirR4ResourcesEffectRunner()
  const [state, setState] = useState<RunnerState>({ _tag: 'idle' })

  const handleParsedResource = useCallback(
    (resource: AnyCollectorResource): void => {
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
      runFhir(upsert).catch((err: unknown) => {
        onError?.(err)
      })
    },
    [runFhir, onError]
  )

  useEffect(() => {
    const remoteKind = makeRemoteForConfig(remote.config)
    const handler = CollectorBridgeMessageHandler.make<AnyCollectorResource>({
      remote: remoteKind,
      sendMessage: sendCollectorMessage,
      onResult: ({ result }) =>
        Either.match(result, {
          onLeft: (err) => {
            setState({ _tag: 'errored', error: err })
            onError?.(err)
          },
          onRight: (parsed) => {
            for (const resource of parsed.resources) handleParsedResource(resource)
          },
        }),
    })

    setActiveHandler(handler)
    setState({ _tag: 'running' })

    return (): void => {
      handler.clear()
      setActiveHandler(null)
    }
  }, [remote, sendCollectorMessage, setActiveHandler, handleParsedResource, onError])

  return state
}

export { useSyncRunner }
export type { RunnerState, SyncRunnerInput }
