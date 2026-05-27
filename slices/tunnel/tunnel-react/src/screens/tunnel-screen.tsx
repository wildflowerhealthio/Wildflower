import { CatchBoundary } from '@tanstack/react-router'
import { Suspense, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import {
  AsyncErrorView,
  Field,
  FieldDescription,
  pageLayoutStyles,
  PageLoading,
} from 'react-tundraish'

import { TunnelToggle } from '../components/TunnelToggle.tsx'
import { useTunnelPatchMutation, useTunnelStateQuery, type TunnelState } from '../queries.ts'
import styles from './tunnel-screen.module.css'

/**
 * Settings landing for the tunnel slice. Reads `TunnelState` through
 * TanStack Query (`useTunnelStateQuery`), so the screen renders from
 * localStorage-persisted cache on mount and the in-flight refetch
 * swaps fresh data in once it lands. Edits go through
 * `useTunnelPatchMutation`, which optimistically projects the change
 * into the cache for instant feedback and rolls back if the daemon
 * rejects the patch.
 */
const TunnelScreen = (): JSX.Element => (
  <CatchBoundary
    getResetKey={() => 'tunnel-screen'}
    errorComponent={({ error }) => <AsyncErrorView error={error} title="Tunnel" />}
  >
    <Suspense fallback={<PageLoading message="Loading tunnel…" />}>
      <TunnelScreenContent />
    </Suspense>
  </CatchBoundary>
)

const TunnelScreenContent = (): JSX.Element => {
  const { data: state } = useTunnelStateQuery()
  return <TunnelScreenBody state={state} />
}

interface TunnelScreenBodyProps {
  readonly state: TunnelState
}

/**
 * Compare the `subdomain` / `rootDomain` strings — empty input maps to
 * `null` so the user clearing a field becomes an explicit `null` write
 * (matching the `SetTunnelRequestBody` schema's "`null` clears,
 * `undefined` preserves" semantics).
 */
const normalizeOptionalString = (raw: string): string | null => {
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

const TunnelScreenBody = ({ state }: TunnelScreenBodyProps): JSX.Element => {
  const patchMutation = useTunnelPatchMutation()
  const [subdomainInput, setSubdomainInput] = useState(state.subdomain ?? '')
  const [rootDomainInput, setRootDomainInput] = useState(state.rootDomain ?? '')

  // `mutation.isPending` is the canonical "in-flight write" signal —
  // wired into every input/button to lock the form during the request.
  // Even though the cached state has already optimistically advanced
  // (so the badge can show "Starting…"), we still want to keep the
  // controls inert until the daemon's response arrives.
  const pending = patchMutation.isPending
  // The mutation hangs onto its last error until the next `mutate` call
  // clears it; surface it next to the existing display.
  const submitError = patchMutation.error
  const errorMessage =
    submitError === null
      ? null
      : submitError instanceof Error
        ? submitError.message
        : String(submitError)

  const nextSubdomain = normalizeOptionalString(subdomainInput)
  const nextRootDomain = normalizeOptionalString(rootDomainInput)

  const dirty = nextSubdomain !== state.subdomain || nextRootDomain !== state.rootDomain

  const onToggle = (requestedRunning: boolean): void => {
    patchMutation.mutate({ requestedRunning })
  }

  const onSave = (): void => {
    patchMutation.mutate({
      subdomain: nextSubdomain,
      rootDomain: nextRootDomain,
    })
  }

  return (
    <div className={pageLayoutStyles['page']}>
      <h1 className="text-heading-4">Tunnel</h1>
      <FieldDescription>
        Expose this device to the public Internet so apps installed on phones can reach it.
      </FieldDescription>

      {errorMessage !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {errorMessage}
        </p>
      ) : null}

      <TunnelToggle
        requestedRunning={state.requestedRunning}
        running={state.running}
        error={state.error}
        disabled={pending}
        onToggle={onToggle}
      />

      <div className={styles['fields']}>
        <Field label="Subdomain">
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="none"
            className={styles['input']}
            value={subdomainInput}
            placeholder="my-clinic"
            disabled={pending}
            onChange={(e) => {
              setSubdomainInput(e.target.value)
            }}
          />
          {state.currentSubdomain !== null && state.currentSubdomain !== state.subdomain ? (
            <FieldDescription>
              <span className={styles['current']}>Running as: {state.currentSubdomain}</span>
            </FieldDescription>
          ) : null}
        </Field>

        <Field label="Root domain">
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            className={styles['input']}
            value={rootDomainInput}
            placeholder="example.com"
            disabled={pending}
            onChange={(e) => {
              setRootDomainInput(e.target.value)
            }}
          />
          {state.currentRootDomain !== null && state.currentRootDomain !== state.rootDomain ? (
            <FieldDescription>
              <span className={styles['current']}>Running as: {state.currentRootDomain}</span>
            </FieldDescription>
          ) : null}
        </Field>
      </div>

      <FieldDescription>
        <span className={styles['current']}>Bound to local server at: {state.servedOrigin}</span>
        {state.currentLocalPort !== null ? (
          <>
            <br />
            <span className={styles['current']}>
              Tunnel forwarding to port {state.currentLocalPort}
            </span>
          </>
        ) : null}
      </FieldDescription>

      <div className={styles['actions']}>
        <button
          type="button"
          className="button-2 filled"
          disabled={pending || !dirty}
          onClick={onSave}
        >
          Save
        </button>
      </div>
    </div>
  )
}

export { TunnelScreen }
