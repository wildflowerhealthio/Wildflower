import { Effect, type Schema } from 'effect'
import { useState, type JSX } from 'react'
import { canonicalPublicOrigin } from 'tunnel-core/canonical-url'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'

import { useTunnelAdminEffectRunner } from '../use-tunnel-effect-runner.ts'

type TunnelState = Schema.Schema.Type<typeof Tunnel.TunnelStateSchema>

interface TunnelToggleProps {
  readonly state: TunnelState
  readonly onChanged: (next: TunnelState) => void
}

/**
 * Toggle button + status row. Disables itself while a `PatchTunnel`
 * write is in flight. The "active" surface state is derived from
 * `currentPublicOrigin !== undefined`; toggling on commits the
 * canonical public URL, toggling off commits `null` (clear).
 */
const TunnelToggle = ({ state, onChanged }: TunnelToggleProps): JSX.Element => {
  const run = useTunnelAdminEffectRunner()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const active = state.currentPublicOrigin !== undefined
  const requesting =
    state.requestedPublicOrigin !== undefined && state.currentPublicOrigin === undefined
  // The wire schema still uses `Schema.optional(...)` so the React layer
  // sees `undefined` for absent fields — null is the on-device storage
  // marker only.

  const buttonLabel = ((): string => {
    if (active) return 'Stop tunnel'
    if (requesting) return 'Requesting…'
    return 'Start tunnel'
  })()

  const toggle = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await run(
        Effect.flatMap(TunnelAdminHttpApiClient, (c) =>
          c.tunnel.PatchTunnel({
            payload: { requestedPublicOrigin: active ? null : canonicalPublicOrigin() },
          })
        )
      )
      onChanged(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        className="button-3"
        disabled={busy}
        onClick={() => {
          void toggle()
        }}
      >
        {buttonLabel}
      </button>
      {error !== null ? (
        <p className="text-body-3" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export { TunnelToggle }
export type { TunnelToggleProps }
