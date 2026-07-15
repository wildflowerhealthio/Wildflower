import { useMutation } from '@tanstack/react-query'
import type { Remotes } from 'collector-registry/http-api-definition'
import { makeScrapingPlanForConfig } from 'collector-registry/registry'
import type { Duration } from 'effect'
import { Match } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from '../queries/use-run-authed.ts'
import {
  buildImportEffect,
  DEFAULT_IDLE_TIMEOUT,
  type FailedResource,
  type ImportSummary,
} from './sync-run.ts'
import { useCollectorRegister } from './use-collector-register.ts'
import { useCollectorSender } from './use-collector-sender.ts'

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
 * Drives a single collector sync as a TanStack triggered mutation over
 * one long, interruptible Effect (see {@link buildImportEffect}). The
 * screen calls {@link SyncRunner.startImport} from its "Import Now"
 * action and reads {@link SyncRunner.state} for the banner;
 * {@link SyncRunner.cancel} aborts the in-flight run.
 *
 * The framework-free core (the drive loop, state machine, and write path)
 * lives in `sync-run.ts`; this hook is only the React seam — the
 * `useMutation` wiring, the `AbortController`, and the `RunnerState`
 * mapping from mutation status. The two React-facing callbacks
 * (`setFailed`, `onError`) are injected into the core as plain functions.
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
  // render doesn't re-key the mutation's closure. The core reads the ref
  // through the plain `(error) => void` it's handed below.
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
        onError: (error) => onErrorRef.current?.(error),
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
