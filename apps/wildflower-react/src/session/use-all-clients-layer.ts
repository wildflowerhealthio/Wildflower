import { Layer } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useGatekeeperClientLayer } from 'gatekeeper-react'
import { useMemo } from 'react'
import { bearerTokenLayer, useAuthTokenSubscribable } from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'

/**
 * Composes every slice's client layer into one self-contained
 * `Layer<AllClients, never, never>` — provides `BearerToken` (read
 * from `<AuthTokenProvider>`) and `webHttpClientLayer` at the bottom.
 *
 * Use this where app code needs to call multiple slice clients in a
 * single Effect (or wants a single composed runtime). Slice-internal
 * screens reach for their slice's per-effect runner instead
 * (`useGatekeeperEffect` / `useGatekeeperEffectRunner` / …), which
 * auto-provide the same trio behind the scenes.
 *
 * The current composition is `[gatekeeper]`; collector and any future
 * slice layers slot in as additional `Layer.mergeAll` arguments when
 * they land.
 */
const useAllClientsLayer = (): Layer.Layer<GatekeeperHttpApiClient> => {
  const gatekeeperLayer = useGatekeeperClientLayer()
  const tokenSubscribable = useAuthTokenSubscribable()

  return useMemo(
    () =>
      gatekeeperLayer.pipe(
        Layer.provide(bearerTokenLayer(tokenSubscribable)),
        Layer.provide(webHttpClientLayer)
      ),
    [gatekeeperLayer, tokenSubscribable]
  )
}

export { useAllClientsLayer }
