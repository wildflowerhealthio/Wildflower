import type { HttpClient } from '@effect/platform'
import type { Layer } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useContext } from 'react'
import type { BearerToken } from 'react-kitchen-sink'

import { GatekeeperClientLayerContext } from './gatekeeper-client-context.ts'

/**
 * Returns the slice's client `Layer` —
 * `Layer<GatekeeperHttpApiClient, never, HttpClient | BearerToken>`.
 * Used by the app's `useAllClientsLayer()` for cross-slice composition.
 *
 * Most screen code shouldn't need this — reach for
 * `useGatekeeperEffect` / `useGatekeeperStream` /
 * `useGatekeeperEffectRunner`, which auto-provide the slice layer,
 * `BearerToken`, and `webHttpClientLayer`.
 *
 * Throws when no `<GatekeeperClientProvider>` is in the tree.
 */
const useGatekeeperClientLayer = (): Layer.Layer<
  GatekeeperHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> => {
  const layer = useContext(GatekeeperClientLayerContext)
  if (layer === null) {
    throw new Error('useGatekeeperClientLayer must be used inside <GatekeeperClientProvider>')
  }
  return layer
}

export { useGatekeeperClientLayer }
