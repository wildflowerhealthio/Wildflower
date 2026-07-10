import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { AccessManagement } from 'gatekeeper-core/http-api-definition'

import type { RunAuthed } from '../router-context.ts'
import { GRANTS_QUERY_KEY, grantQueryKey } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

type Grant = Schema.Schema.Type<typeof AccessManagement.GrantSchema>
/** The authorization-code ("Approved App") variant of the grant union. */
type AppGrant = Extract<Grant, { readonly grantType: 'authorization_code' }>
/** The device-code ("Authorized Device") variant of the grant union. */
type DeviceGrant = Extract<Grant, { readonly grantType: 'device_code' }>

/** Shared by the route `loader` (`ensureQueryData`) and {@link useGrantsQuery}. */
const grantsQueryOptions = (
  runAuthed: RunAuthed
): UseSuspenseQueryOptions<readonly Grant[], Error, readonly Grant[], typeof GRANTS_QUERY_KEY> =>
  queryOptions({
    queryKey: GRANTS_QUERY_KEY,
    queryFn: () =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) => c['access-management'].ListGrants())
      ),
    // Always re-read the list when the access page (re)mounts. Authorizing an
    // app or pairing a device happens *outside* this React tree (an OAuth
    // redirect / the device-consent popup), so nothing here invalidates the
    // list; under the app's 5-minute `staleTime` the loader's `ensureQueryData`
    // would otherwise serve a stale cache and the new grant wouldn't appear
    // until the window elapsed. `'always'` refetches on mount regardless of
    // staleness while still rendering the cached rows immediately.
    refetchOnMount: 'always',
  })

/** Reads synchronously from cache when the route loader has already warmed it. */
const useGrantsQuery = (): UseSuspenseQueryResult<readonly Grant[], Error> =>
  useSuspenseQuery(grantsQueryOptions(useRunAuthed()))

/** Shared by the route `loader` and {@link useGrantQuery}. */
const grantQueryOptions = (
  runAuthed: RunAuthed,
  id: string
): UseSuspenseQueryOptions<Grant, Error, Grant, readonly [string, string, string]> =>
  queryOptions({
    queryKey: grantQueryKey(id),
    queryFn: () =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          c['access-management'].GetGrant({ path: { id } })
        )
      ),
  })

const useGrantQuery = (id: string): UseSuspenseQueryResult<Grant, Error> =>
  useSuspenseQuery(grantQueryOptions(useRunAuthed(), id))

/** `RevokeGrant` (DELETE). Invalidates the grants list + the revoked grant's detail. */
const useRevokeGrantMutation = (): UseMutationResult<unknown, Error, { readonly id: string }> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }) =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          c['access-management'].RevokeGrant({ path: { id } })
        )
      ),
    onSuccess: async (_data, { id }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: GRANTS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: grantQueryKey(id) }),
      ])
    },
  })
}

export {
  grantQueryOptions,
  grantsQueryOptions,
  useGrantQuery,
  useGrantsQuery,
  useRevokeGrantMutation,
}
export type { AppGrant, DeviceGrant, Grant }
