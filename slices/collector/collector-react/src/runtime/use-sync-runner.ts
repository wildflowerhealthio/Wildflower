/**
 * The thin React shell around the framework-free sync-run core
 * (`./sync-run.ts`): the `useMutation` wiring, the per-run
 * `AbortController`, and the `RunnerState` mapping. It injects the two
 * React-facing callbacks (`setFailed` / `onError`) into the core as plain
 * functions.
 *
 * Where a collector's parsed resources are written is no longer decided
 * here: the registry's `resourcePersistenceRuntimeForConfig` hands back the
 * config's plan plus its batch `persistResources` sink (from the owning
 * `CollectorDescriptor`), which this hook feeds to the generic
 * runner. The runner's requirement `R` is the union of every collector's
 * write requirement (today `FhirR4ResourcesHttpApiClient`); the router
 * context's authed runner provides it. That residual coupling to the FHIR
 * R4 EMR slice is documented as a deliberate slice-layering exception in the
 * `collector-react/package.json` description (per `slices/AGENTS.md`).
 */
import { useMutation } from '@tanstack/react-query'
import type { Remotes } from 'collector-registry/http-api-definition'
import { resourcePersistenceRuntimeForConfig } from 'collector-registry/registry'
import { type Duration, Match } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from '../queries/use-run-authed.ts'
import { buildImportEffect, type FailedResource, type ImportSummary } from './sync-run.ts'
import { useCollectorRegister } from './use-collector-register.ts'
import { useCollectorSender } from './use-collector-sender.ts'

/**
 * Optional hook config. `onError` notifies the screen of parse/transport
 * failures and write-retry exhaustion (fired once per failed item, after
 * retries). `idleTimeout` is the stalled-host guard: if no sniffer event
 * arrives within the window the run settles anyway, so a silent host
 * can't pin the mutation in `pending` forever.
 *
 * Supplying `idleTimeout` **overrides the collector's own
 * `ScrapingPlan.idleTimeout`** for this runner; omitting it lets the plan's
 * value apply, falling back to `sync-run.ts`'s `DEFAULT_IDLE_TIMEOUT`. It is
 * deliberately left `undefined` rather than defaulted here — defaulting at this
 * boundary would make every run look like an explicit override and the plan's
 * guard could never take effect.
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
const useSyncRunner = ({ onError, idleTimeout }: SyncRunnerInput = {}): SyncRunner => {
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

  // Assemble the generic runner for a stored config. The registry hands
  // back the config's `ResourcePersistenceRuntime`; `.run` (NOT
  // `Effect.provide`) provides the sealed `context` to our program — the
  // `(context) => buildImportEffect(...)` body — over the hidden `Resources`.
  // Kept as one flat step so `mutationFn` below reads "build → run authed".
  const buildImportEffectForConfig = useCallback(
    (config: CollectorRemote['config']) =>
      resourcePersistenceRuntimeForConfig(config).run((context) =>
        buildImportEffect({
          context,
          sendCollectorMessage,
          collectorRegister,
          onNewFailureCause: (error) => onErrorRef.current?.(error),
          onFailureSetUpdated: setFailed,
          idleTimeout,
        })
      ),
    [sendCollectorMessage, collectorRegister, setFailed, idleTimeout]
  )

  const mutation = useMutation<ImportSummary, Error, CollectorRemote>({
    mutationFn: (remote) => {
      const controller = new AbortController()
      abortRef.current = controller
      return runAuthed(buildImportEffectForConfig(remote.config), {
        signal: controller.signal,
      }).catch((error: unknown) => {
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
    Match.when({ status: 'pending' }, (): RunnerState =>
      failed.length > 0 ? { _tag: 'partial', failed } : { _tag: 'running' }
    ),
    Match.when({ status: 'success', data: { cancelled: true } }, (): RunnerState => ({
      _tag: 'idle',
    })),
    Match.when({ status: 'success' }, (): RunnerState =>
      failed.length > 0 ? { _tag: 'partial', failed } : { _tag: 'done' }
    ),
    Match.orElse((): RunnerState => ({ _tag: 'idle' }))
  )

  return { state, startImport, cancel }
}

export { useSyncRunner }
export type { FailedResource, RunnerState, SyncRunner, SyncRunnerInput }
