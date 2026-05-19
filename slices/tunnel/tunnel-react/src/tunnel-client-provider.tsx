import type { JSX, PropsWithChildren } from 'react'

import { buildTunnelAdminClientLayer } from './client/tunnel-client.ts'
import { TunnelAdminClientLayerContext } from './tunnel-client-context.ts'

// The slice's client layer no longer depends on a token directly —
// `buildTunnelAdminClientLayer()` reads from the `BearerToken` service
// at request time, so a single layer instance suffices for the entire
// app. Build it once at module load and re-use across every mount.
const tunnelAdminClientLayer = buildTunnelAdminClientLayer()

type TunnelClientProviderProps = PropsWithChildren

/**
 * Provides the tunnel slice's admin client `Layer` to descendants via
 * {@link TunnelAdminClientLayerContext}. No token prop — the layer
 * reads the live token from {@link BearerToken} (a Subscribable
 * provided higher in the tree via `<AuthTokenProvider>` from
 * react-kitchen-sink).
 *
 * The tunnel API is owner-only — there is no public counterpart — so
 * this provider must sit inside an authenticated subtree (typically the
 * host app's `<AuthorizedAppShell>`).
 */
const TunnelClientProvider = ({ children }: TunnelClientProviderProps): JSX.Element => (
  <TunnelAdminClientLayerContext.Provider value={tunnelAdminClientLayer}>
    {children}
  </TunnelAdminClientLayerContext.Provider>
)

export { TunnelClientProvider }
export type { TunnelClientProviderProps }
