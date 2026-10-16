import { queryOptions, skipToken, useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { discoverSmartEndpoints } from '@wildflowerhealthio/authorization-core/smart-client'
import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'
import { Effect, Option } from 'effect'
import { createContext, useContext } from 'react'

/**
 * Where the settings screen's "Manage access" row finds the session's server
 * and reads its SMART configuration from: the page's own `fetch`, and whether
 * the page is served over https (discovery refuses a plaintext endpoint from a
 * secure page). `buildAppTree` provides it over the page's bearer store.
 */
interface ManageAccessSource {
  /** The server this tab signed in to, read when the row renders. */
  readonly serverUrl: () => string | undefined
  readonly fetch: typeof globalThis.fetch
  readonly pageIsSecure: boolean
}

/**
 * The {@link ManageAccessSource} the settings screen reads. A React context, as
 * the Logout row's is (`logout-settings-item-context.ts`). Defaults to no
 * server, so a component mounted outside a provider renders no row.
 */
const ManageAccessSourceContext = createContext<ManageAccessSource>({
  serverUrl: () => undefined,
  fetch: (...args) => globalThis.fetch(...args),
  pageIsSecure: false,
})

/**
 * The `management_endpoint` the SMART configuration of `serverUrl` advertises,
 * or `null` when it advertises none. A Wildflower server's is the hosted
 * Wildflower Authorization app pointed at itself
 * (`https://authorization.wildflowerhealth.io/?iss=…`). The configuration does
 * not change while the page is open, so it is read once. Skipped while no
 * server is signed in to.
 */
const managementEndpointQueryOptions = (
  serverUrl: string | undefined,
  source: Pick<ManageAccessSource, 'fetch' | 'pageIsSecure'>
): UseQueryOptions<
  string | null,
  Error,
  string | null,
  readonly ['management-endpoint', string | undefined]
> =>
  queryOptions({
    queryKey: ['management-endpoint', serverUrl] as const,
    queryFn:
      serverUrl === undefined
        ? skipToken
        : () =>
            Effect.runPromise(
              discoverSmartEndpoints(serverUrl, source).pipe(
                Effect.map((issuer) => Option.getOrNull(issuer.managementEndpoint))
              )
            ),
    staleTime: Infinity,
  })

/** The "Manage access" row, linking out to `managementEndpoint`. */
const manageAccessSettingsItem = (managementEndpoint: string): SettingsItem => ({
  id: 'manage-access',
  title: 'Manage access',
  subtitle: 'See and take back what apps and devices can reach',
  href: managementEndpoint,
  external: true,
})

/**
 * The settings screen's "Manage access" row: a link to the session's server's
 * `management_endpoint`, where the Owner manages what that server has
 * authorized. None while the configuration is loading, when it failed to load,
 * or when it advertises no `management_endpoint`.
 */
const useManageAccessSettingsItem = (): Option.Option<SettingsItem> => {
  const source = useContext(ManageAccessSourceContext)
  const { data: managementEndpoint } = useQuery(
    managementEndpointQueryOptions(source.serverUrl(), source)
  )
  return Option.fromNullable(managementEndpoint).pipe(Option.map(manageAccessSettingsItem))
}

export {
  ManageAccessSourceContext,
  managementEndpointQueryOptions,
  manageAccessSettingsItem,
  useManageAccessSettingsItem,
}
export type { ManageAccessSource }
