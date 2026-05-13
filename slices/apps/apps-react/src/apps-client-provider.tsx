import type { JSX, PropsWithChildren } from 'react'

import { AppsClientLayerContext } from './apps-client-context.ts'
import { buildAppsClientLayer } from './client/apps-client.ts'

// The slice's client layer no longer depends on a token directly —
// `buildAppsClientLayer()` reads from the `BearerToken` service at
// request time, so a single layer instance suffices for the entire app.
// Build it once at module load and re-use across every mount.
const appsClientLayer = buildAppsClientLayer()

type AppsClientProviderProps = PropsWithChildren

/**
 * Provides the slice's client `Layer` to descendants via
 * {@link AppsClientLayerContext}. No token prop — the layer reads the
 * live token from {@link BearerToken} (a Subscribable provided higher
 * in the tree via `<AuthTokenProvider>` from react-kitchen-sink).
 */
const AppsClientProvider = ({ children }: AppsClientProviderProps): JSX.Element => (
  <AppsClientLayerContext.Provider value={appsClientLayer}>
    {children}
  </AppsClientLayerContext.Provider>
)

export { AppsClientProvider }
export type { AppsClientProviderProps }
