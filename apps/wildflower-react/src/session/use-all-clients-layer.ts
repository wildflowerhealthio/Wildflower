import { Layer } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useGatekeeperClientLayer } from 'gatekeeper-react'
import { useMemo } from 'react'
import { webHttpClientLayer } from 'telemetry-react'

/**
 * Composes every slice's client layer into one self-contained
 * `Layer<AllClients, never, never>`, with the shared
 * {@link webHttpClientLayer} provided once at the bottom.
 *
 * Use this where app code needs to call multiple slice clients in a
 * single Effect (or wants a single composed runtime). Slice-internal
 * screens reach for their own `use<Slice>ClientLayer()` hook instead,
 * piping the layer through `Effect.provide` directly — that keeps
 * each screen's requirements visible at the call site.
 *
 * The current composition is `[gatekeeper]`; collector and any future
 * slice layers slot in as additional `Layer.mergeAll` arguments when
 * they land.
 */
const useAllClientsLayer = (): Layer.Layer<GatekeeperHttpApiClient> => {
  const gatekeeperLayer = useGatekeeperClientLayer()

  return useMemo(() => gatekeeperLayer.pipe(Layer.provide(webHttpClientLayer)), [gatekeeperLayer])
}

export { useAllClientsLayer }
