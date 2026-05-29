import { createFileRoute } from '@tanstack/react-router'
import { Effect, type Schema } from 'effect'
import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Awaited, PageLoading, Field, FieldDescription, pageLayoutStyles } from 'react-tundraish'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'

import { TunnelToggle } from '../../../components/TunnelToggle.tsx'
import { useTunnelAdminEffectRunner } from '../../../use-tunnel-admin-effect-runner.ts'
import { useTunnelAdminEffect } from '../../../use-tunnel-admin-effect.ts'
import styles from './index.module.css'

type TunnelState = Schema.Schema.Type<typeof Tunnel.TunnelStateSchema>

interface TunnelScreenBodyProps {
  readonly state: TunnelState
  readonly onChanged: () => void
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

const TunnelScreenBody = ({ state, onChanged }: TunnelScreenBodyProps): JSX.Element => {
  const runTunnel = useTunnelAdminEffectRunner()
  const [subdomainInput, setSubdomainInput] = useState(state.subdomain ?? '')
  const [rootDomainInput, setRootDomainInput] = useState(state.rootDomain ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const nextSubdomain = normalizeOptionalString(subdomainInput)
  const nextRootDomain = normalizeOptionalString(rootDomainInput)

  const dirty = nextSubdomain !== state.subdomain || nextRootDomain !== state.rootDomain

  const patch = async (payload: {
    readonly subdomain?: string | null
    readonly rootDomain?: string | null
    readonly requestedRunning?: boolean
  }): Promise<void> => {
    setError(null)
    setPending(true)
    try {
      await runTunnel(
        Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.PatchTunnel({ payload }))
      )
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  const onToggle = (requestedRunning: boolean): void => {
    void patch({ requestedRunning })
  }

  const onSave = (): void => {
    void patch({
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

      {error !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {error}
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

function TunnelScreen(): JSX.Element {
  const [refreshKey, setRefreshKey] = useState(0)

  const tunnelEffect = useMemo(
    () => Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.GetTunnel()),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [refreshKey]
  )

  const tunnelPromise = useTunnelAdminEffect(tunnelEffect)

  return (
    <Suspense fallback={<PageLoading message="Loading tunnel…" />}>
      <Awaited promise={tunnelPromise} resetKey={refreshKey} errorTitle="Tunnel">
        {(state) => (
          <TunnelScreenBody
            state={state}
            onChanged={() => {
              setRefreshKey((n) => n + 1)
            }}
          />
        )}
      </Awaited>
    </Suspense>
  )
}

/**
 * The `/settings/tunnel/` landing route. Defined as a file route so the
 * slice generates its own `routeTree.gen.ts`; in `apps/wildflower-react`
 * this same file is mounted under the app's `/settings` route via
 * `@tanstack/virtual-file-routes`, which computes the identical
 * `/settings/tunnel/` id, so the literal below is stable across both trees.
 */
export const Route = createFileRoute('/settings/tunnel/')({
  component: TunnelScreen,
})
