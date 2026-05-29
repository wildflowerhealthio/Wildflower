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
 * Loader is best-effort: the `/settings` gate is a React component, not
 * `beforeLoad`, so on embedded first paint the bearer token may not yet
 * exist and the prefetch can 401. The in-component `useSuspenseQuery`
 * (rendered only after `RequireAuth` passes) does the real read in that
 * case.
 */
export const Route = createFileRoute('/settings/tunnel/')({
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(tunnelStateQueryOptions(context.runAuthed))
    } catch {
      // see route doc — embedded first paint before token lands.
    }
  },
  component: TunnelScreenContent,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Tunnel" />,
})
