import type { JSX, PropsWithChildren } from 'react'

import { buildCollectorClientLayer } from './client/collector-client.ts'
import { CollectorClientLayerContext } from './collector-client-context.ts'

// The slice's client layer no longer depends on a token directly —
// `buildCollectorClientLayer()` reads from the `BearerToken` service at
// request time, so a single layer instance suffices for the entire app.
// Build it once at module load and re-use across every mount.
const collectorClientLayer = buildCollectorClientLayer()

type CollectorClientProviderProps = PropsWithChildren

/**
 * Provides the slice's client `Layer` to descendants via
 * {@link CollectorClientLayerContext}. No token prop — the layer
 * reads the live token from {@link BearerToken} (a Subscribable
 * provided higher in the tree via `<AuthTokenProvider>` from
 * react-kitchen-sink).
 */
const CollectorClientProvider = ({ children }: CollectorClientProviderProps): JSX.Element => (
  <CollectorClientLayerContext.Provider value={collectorClientLayer}>
    {children}
  </CollectorClientLayerContext.Provider>
)

export { CollectorClientProvider }
export type { CollectorClientProviderProps }
