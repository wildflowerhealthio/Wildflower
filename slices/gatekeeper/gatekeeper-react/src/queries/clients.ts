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
import { CLIENTS_QUERY_KEY } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

/** A registered OAuth client — a row of the Owner's "Trusted Apps" list. */
type Client = Schema.Schema.Type<typeof AccessManagement.ClientSchema>

/** Which way {@link useSetClientDisabledMutation} flips a client. */
type ClientSwitch = 'disable' | 'enable'

/** Shared by the route `loader` (`ensureQueryData`) and {@link useClientsQuery}. */
const clientsQueryOptions = (
  runAuthed: RunAuthed
): UseSuspenseQueryOptions<readonly Client[], Error, readonly Client[], typeof CLIENTS_QUERY_KEY> =>
  queryOptions({
    queryKey: CLIENTS_QUERY_KEY,
    queryFn: () =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) => c['access-management'].ListClients())
      ),
    // Approving an unknown app (trust on first use) creates a client row from
    // the consent popup, outside this React tree — refetch on mount so it shows
    // up, for the same reason the grants list does.
    refetchOnMount: 'always',
  })

/** Reads synchronously from cache when the route loader has already warmed it. */
const useClientsQuery = (): UseSuspenseQueryResult<readonly Client[], Error> =>
  useSuspenseQuery(clientsQueryOptions(useRunAuthed()))

/** `DisableClient` / `EnableClient` (POST). Invalidates the clients list. */
const useSetClientDisabledMutation = (): UseMutationResult<
  unknown,
  Error,
  { readonly clientId: string; readonly action: ClientSwitch }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ clientId, action }) => {
      // `HttpApiClient` splices path params in raw, and trust on first use
      // admits any `client_id` string — a URL-shaped one (`https://app/cb`)
      // would otherwise split into extra segments and miss the route.
      const path = { clientId: encodeURIComponent(clientId) }
      return runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          action === 'disable'
            ? c['access-management'].DisableClient({ path })
            : c['access-management'].EnableClient({ path })
        )
      )
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CLIENTS_QUERY_KEY })
    },
  })
}

export { clientsQueryOptions, useClientsQuery, useSetClientDisabledMutation }
export type { Client, ClientSwitch }
