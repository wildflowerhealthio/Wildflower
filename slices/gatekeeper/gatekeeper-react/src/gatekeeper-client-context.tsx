import { useMemo, type JSX, type PropsWithChildren } from 'react'

import { buildGatekeeperClientLayer } from './client/gatekeeper-client.ts'
import { GatekeeperClientLayerContext } from './gatekeeper-client-context.ts'

type GatekeeperClientProviderProps = PropsWithChildren<{
  /**
   * Bearer token attached to every gatekeeper API call. `null` produces
   * an unauthenticated client suitable for public endpoints (OAuth device
   * flow, polling). The provider memoises the layer on `token` so a
   * rotation rebuilds it lazily; no `ManagedRuntime` is constructed here —
   * apps compose layers and materialise their own runtime (or rely on
   * `useEffectTs` from `telemetry-react` to run effects with the layer
   * already provided).
   */
  readonly token: string | null
}>

/**
 * Provides the slice's client `Layer` to descendants via
 * {@link GatekeeperClientLayerContext}. The root app wraps the whole
 * tree with `token={null}` for public routes;
 * `<AuthorizedAppShell>` re-wraps inside with the live token so
 * authenticated screens see a bearer-attached layer through the same
 * hook.
 */
const GatekeeperClientProvider = ({
  token,
  children,
}: GatekeeperClientProviderProps): JSX.Element => {
  const layer = useMemo(() => buildGatekeeperClientLayer(token), [token])

  return (
    <GatekeeperClientLayerContext.Provider value={layer}>
      {children}
    </GatekeeperClientLayerContext.Provider>
  )
}

export { GatekeeperClientProvider }
export type { GatekeeperClientProviderProps }
