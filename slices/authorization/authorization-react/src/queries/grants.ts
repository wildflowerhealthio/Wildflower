import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import type { AccessManagement } from '@wildflowerhealthio/authorization-core/http-api-definition'
import { Effect, type Schema } from 'effect'

import type { RunAuthed } from '../router-context.ts'
import { GRANTS_QUERY_KEY, grantQueryKey } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

type Grant = Schema.Schema.Type<typeof AccessManagement.GrantSchema>

/** True for the 404 `RevokeGrant` and `GetGrant` answer for a grant that doesn't exist. */
const isGrantNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'error' in error && error.error === 'GrantNotFound'
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
        Effect.flatMap(AuthorizationServerHttpApiClient, (c) => c['access-management'].ListGrants())
      ),
    // Always re-read the list when the access page (re)mounts. Authorizing an
    // app or pairing a device happens *outside* this React tree (an OAuth
    // redirect / the server's consent pages), so nothing here invalidates the
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
        Effect.flatMap(AuthorizationServerHttpApiClient, (c) =>
          c['access-management'].GetGrant({ path: { id } })
        )
      ),
  })

const useGrantQuery = (id: string): UseSuspenseQueryResult<Grant, Error> =>
  useSuspenseQuery(grantQueryOptions(useRunAuthed(), id))

/** `useRevokeGrantMutation`'s input: the grant, and the client it was granted to. */
interface RevokeGrantVariables {
  readonly id: string
  readonly clientId: string
}

/**
 * Revoke a grant: `RevokeGrant` (DELETE), then `CreateRevocation` for the
 * grant's client, so every token the client holds stops working now, whatever
 * else it was issued under. The second call runs only once the grant is gone.
 * Invalidates the grants list and the revoked grant's detail.
 */
const useRevokeGrantMutation = (): UseMutationResult<void, Error, RevokeGrantVariables> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, clientId }) =>
      runAuthed(
        Effect.gen(function* () {
          const client = yield* AuthorizationServerHttpApiClient
          // Already gone means an earlier revoke deleted the grant but its
          // revocation failed: carry on and revoke the client's tokens now.
          yield* client['access-management']
            .RevokeGrant({ path: { id } })
            .pipe(Effect.catchIf(isGrantNotFound, () => Effect.void))
          yield* client['access-management'].CreateRevocation({
            payload: { subject: clientId },
          })
        })
      ),
    // On failure too: the DELETE may have landed before the revocation
    // failed, and the list must not keep showing a grant that's gone.
    onSettled: async (_data, _error, { id }) => {
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
export type { AppGrant, DeviceGrant, Grant, RevokeGrantVariables }
