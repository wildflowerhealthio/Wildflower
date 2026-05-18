import { Effect, type Schema } from 'effect'
import { useState, type JSX } from 'react'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'

import { useTunnelAdminEffectRunner } from '../use-tunnel-effect-runner.ts'

type TunnelState = Schema.Schema.Type<typeof Tunnel.TunnelStateSchema>

interface TunnelToggleProps {
  readonly state: TunnelState
  readonly onChanged: (next: TunnelState) => void
}

/**
 * Toggle button. Flips `requestedEnabled` on the persistent
 * `TunnelConfig` via `PatchTunnel`. The button surface state derives
 * from `currentEnabled` (the daemon's view) with a "Requesting…"
 * intermediate when the user has asked but the daemon hasn't brought
 * the tunnel up yet.
 */
const TunnelToggle = ({ state, onChanged }: TunnelToggleProps): JSX.Element => {
  const run = useTunnelAdminEffectRunner()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const active = state.currentEnabled
  const requesting = state.requestedEnabled && !state.currentEnabled

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
            payload: { requestedEnabled: !state.requestedEnabled },
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
