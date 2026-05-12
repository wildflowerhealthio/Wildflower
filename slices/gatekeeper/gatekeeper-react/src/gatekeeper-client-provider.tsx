import type { JSX, PropsWithChildren } from 'react'

import { buildGatekeeperClientLayer } from './client/gatekeeper-client.ts'
import { GatekeeperClientLayerContext } from './gatekeeper-client-context.ts'

// The slice's client layer no longer depends on a token directly —
// `buildGatekeeperClientLayer()` reads from the `BearerToken` service at
// request time, so a single layer instance suffices for the entire app.
// Build it once at module load and re-use across every mount.
const gatekeeperClientLayer = buildGatekeeperClientLayer()

type GatekeeperClientProviderProps = PropsWithChildren

/**
 * Provides the slice's client `Layer` to descendants via
 * {@link GatekeeperClientLayerContext}. No token prop — the layer
 * reads the live token from {@link BearerToken} (a Subscribable
 * provided higher in the tree via `<AuthTokenProvider>` from
 * react-kitchen-sink). Authenticated and unauthenticated routes share
 * the same provider; only the rendered UI differs.
 */
const GatekeeperClientProvider = ({ children }: GatekeeperClientProviderProps): JSX.Element => (
  <GatekeeperClientLayerContext.Provider value={gatekeeperClientLayer}>
    {children}
  </GatekeeperClientLayerContext.Provider>
)

export { GatekeeperClientProvider }
export type { GatekeeperClientProviderProps }
