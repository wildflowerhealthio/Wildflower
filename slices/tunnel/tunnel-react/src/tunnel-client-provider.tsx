import type { JSX, PropsWithChildren } from 'react'

import { buildTunnelAdminClientLayer } from './client/tunnel-client.ts'
import { TunnelAdminClientLayerContext } from './tunnel-client-context.ts'

const tunnelAdminClientLayer = buildTunnelAdminClientLayer()

type TunnelClientProviderProps = PropsWithChildren

/**
 * Provides the tunnel-admin client `Layer` to descendants via
 * {@link TunnelAdminClientLayerContext}. No token prop — the layer
 * reads the live token from {@link BearerToken} (provided higher in
 * the tree by `<AuthTokenProvider>`).
 */
const TunnelClientProvider = ({ children }: TunnelClientProviderProps): JSX.Element => (
  <TunnelAdminClientLayerContext.Provider value={tunnelAdminClientLayer}>
    {children}
  </TunnelAdminClientLayerContext.Provider>
)

export { TunnelClientProvider }
export type { TunnelClientProviderProps }
