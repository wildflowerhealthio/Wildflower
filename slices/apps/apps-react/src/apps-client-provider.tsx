import type { JSX, PropsWithChildren } from 'react'

import { AppsAdminClientLayerContext, AppsClientLayerContext } from './apps-client-context.ts'
import { buildAppsAdminClientLayer, buildAppsClientLayer } from './client/apps-client.ts'

// Neither layer depends on a token at build time — the admin layer reads
// the live token from the `BearerToken` service at request time, so a
// single layer instance suffices for the entire app. Build each once at
// module load and re-use across every mount.
const appsClientLayer = buildAppsClientLayer()
const appsAdminClientLayer = buildAppsAdminClientLayer()

type AppsClientProviderProps = PropsWithChildren

/**
 * Provides both apps client `Layer`s to descendants — the public layer
 * (`AppsApi`, tokenless) via {@link AppsClientLayerContext}, and the
 * admin layer (`AppsAdminApi`, bearer-attaching) via
 * {@link AppsAdminClientLayerContext}. No token prop — the admin layer
 * reads the live token from {@link BearerToken} (a Subscribable
 * provided higher in the tree via `<AuthTokenProvider>` from
 * react-kitchen-sink).
 */
const AppsClientProvider = ({ children }: AppsClientProviderProps): JSX.Element => (
  <AppsClientLayerContext.Provider value={appsClientLayer}>
    <AppsAdminClientLayerContext.Provider value={appsAdminClientLayer}>
      {children}
    </AppsAdminClientLayerContext.Provider>
  </AppsClientLayerContext.Provider>
)

export { AppsClientProvider }
export type { AppsClientProviderProps }
