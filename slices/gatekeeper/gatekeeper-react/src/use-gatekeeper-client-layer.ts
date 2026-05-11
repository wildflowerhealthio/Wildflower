import type { HttpClient } from '@effect/platform'
import type { Layer } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useContext } from 'react'

import { GatekeeperClientLayerContext } from './gatekeeper-client-context.ts'

/**
 * Returns the slice's client `Layer` — `Layer<GatekeeperHttpApiClient,
 * never, HttpClient>`. Compose with other slices' layers in the app's
 * `useAllClientsLayer()`, or pipe directly via `Effect.provide(layer)`
 * before passing to `useEffectTs` from `telemetry-react` (which
 * auto-provides `HttpClient`).
 *
 * Throws when no `<GatekeeperClientProvider>` is in the tree.
 */
const useGatekeeperClientLayer = (): Layer.Layer<
  GatekeeperHttpApiClient,
  never,
  HttpClient.HttpClient
> => {
  const layer = useContext(GatekeeperClientLayerContext)
  if (layer === null) {
    throw new Error('useGatekeeperClientLayer must be used inside <GatekeeperClientProvider>')
  }
  return layer
}

export { useGatekeeperClientLayer }
