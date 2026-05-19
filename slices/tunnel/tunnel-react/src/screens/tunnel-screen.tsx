import { Effect, type Schema } from 'effect'
import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Await } from 'react-router'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'

import { AsyncErrorView } from '../components/AsyncErrorView.tsx'
import { Field, FieldDescription } from '../components/Field.tsx'
import { PageLoading } from '../components/PageLoading.tsx'
import { TunnelToggle } from '../components/TunnelToggle.tsx'
import { useTunnelAdminEffectRunner } from '../use-tunnel-admin-effect-runner.ts'
import { useTunnelAdminEffect } from '../use-tunnel-admin-effect.ts'
import pageLayout from '../styles/page-layout.module.css'
import styles from './tunnel-screen.module.css'

type TunnelState = Schema.Schema.Type<typeof Tunnel.TunnelStateSchema>

const TunnelScreen = (): JSX.Element => {
  const [refreshKey, setRefreshKey] = useState(0)

  const tunnelEffect = useMemo(
    () => Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.GetTunnel()),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [refreshKey]
  )

  const tunnelPromise = useTunnelAdminEffect(tunnelEffect)

  return (
    <Suspense fallback={<PageLoading message="Loading tunnel…" />}>
      <Await resolve={tunnelPromise} errorElement={<AsyncErrorView title="Tunnel" />}>
        {(state: TunnelState) => (
          <TunnelScreenBody
            state={state}
            onChanged={() => {
              setRefreshKey((n) => n + 1)
            }}
          />
        )}
      </Await>
    </Suspense>
  )
}

interface TunnelScreenBodyProps {
  readonly state: TunnelState
  readonly onChanged: () => void
}

/**
 * Convert the `<input type="number">` raw string into the PATCH body
 * shape. Empty string → `null` (explicit clear). Anything else parses
 * as a base-10 integer; the input's `min`/`step` keep this lenient
 * (the schema rejects NaN, and the daemon validates port ranges).
 */
const parseLocalPortInput = (raw: string): number | null => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) ? parsed : null
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
  const [localPortInput, setLocalPortInput] = useState(
    state.localPort === null ? '' : String(state.localPort)
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const nextSubdomain = normalizeOptionalString(subdomainInput)
  const nextRootDomain = normalizeOptionalString(rootDomainInput)
  const nextLocalPort = parseLocalPortInput(localPortInput)

  const dirty =
    nextSubdomain !== state.subdomain ||
    nextRootDomain !== state.rootDomain ||
    nextLocalPort !== state.localPort

  const patch = async (payload: {
    readonly subdomain?: string | null
    readonly rootDomain?: string | null
    readonly localPort?: number | null
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
      localPort: nextLocalPort,
    })
  }

  return (
    <div className={pageLayout['page']}>
      <h1 className="text-heading-4">Tunnel</h1>
      <FieldDescription>
        Expose this device to the public Internet so apps installed on phones can reach it.
      </FieldDescription>

      {error !== null ? (
        <p className={cn(pageLayout['error'], 'text-body-3')} role="alert">
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

        <Field label="Local port">
          <input
            type="number"
            inputMode="numeric"
            autoComplete="off"
            className={styles['input']}
            value={localPortInput}
            placeholder="3000"
            min={1}
            max={65535}
            step={1}
            onChange={(e) => {
              setLocalPortInput(e.target.value)
            }}
          />
          {state.currentLocalPort !== null && state.currentLocalPort !== state.localPort ? (
            <FieldDescription>
              <span className={styles['current']}>Running on: {state.currentLocalPort}</span>
            </FieldDescription>
          ) : null}
        </Field>
      </div>

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
