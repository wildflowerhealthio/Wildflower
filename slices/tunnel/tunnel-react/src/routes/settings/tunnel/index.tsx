import { createFileRoute } from '@tanstack/react-router'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, Field, FieldDescription, pageLayoutStyles } from 'react-tundraish'

import { TunnelToggle } from '../../../components/TunnelToggle.tsx'
import {
  tunnelStateQueryOptions,
  useTunnelPatchMutation,
  useTunnelStateQuery,
  type TunnelState,
} from '../../../queries.ts'
import styles from './index.module.css'

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

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const TunnelScreenBody = ({ state }: TunnelScreenBodyProps): JSX.Element => {
  const patchMutation = useTunnelPatchMutation()
  const [subdomainInput, setSubdomainInput] = useState(state.subdomain ?? '')
  const [rootDomainInput, setRootDomainInput] = useState(state.rootDomain ?? '')

  // Locks inputs even though the optimistic state has already advanced.
  const pending = patchMutation.isPending
  const submitError = patchMutation.error
  const errorMessage = submitError === null ? null : formatError(submitError)

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

const TunnelScreenContent = (): JSX.Element => {
  const { data: state } = useTunnelStateQuery()
  return <TunnelScreenBody state={state} />
}

/**
 * Loader warms the `TunnelState` cache for first paint — but only when
 * the bearer token is already available.
 *
 * The `/settings` auth gate is a React component, not a `beforeLoad`, so
 * on embedded first paint the bridge hasn't delivered the token when the
 * loader runs. We must not prefetch then (it would 401); instead we
 * return early and let the post-gate in-component `useSuspenseQuery`
 * (rendered only after the gate passes) do the first read once the token
 * lands. `context.isTokenReady()` distinguishes that case from standalone
 * web, where the token is present synchronously from localStorage.
 *
 * When the token IS ready we prefetch and deliberately do NOT swallow
 * failures: a genuine error (500, schema-invalid, network) propagates so
 * the route's `errorComponent` (`AsyncErrorView`) renders instead of
 * vanishing silently — important because `defaultPreload: 'intent'` fires
 * this loader on hover with no component mounted to surface the error.
 */
export const Route = createFileRoute('/settings/tunnel/')({
  loader: async ({ context }) => {
    // Token not yet delivered (embedded first paint): defer to the
    // in-component read rather than 401-ing a prefetch.
    if (!context.isTokenReady()) return
    await context.queryClient.ensureQueryData(tunnelStateQueryOptions(context.runAuthed))
  },
  component: TunnelScreenContent,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Tunnel" />,
})
