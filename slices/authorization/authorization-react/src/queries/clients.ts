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
import type { Client } from '@wildflowerhealthio/authorization-core/domain'
import type { AccessManagement } from '@wildflowerhealthio/authorization-core/http-api-definition'
import { Data, DateTime, Effect, type Schema } from 'effect'

import type { RunAuthed } from '../router-context.ts'
import { CLIENTS_QUERY_KEY } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

/** Which way a "Trusted Apps" row's switch flips a client. */
type ClientSwitch = 'disable' | 'enable'

/** Shared by the route `loader` (`ensureQueryData`) and {@link useClientsQuery}. */
const clientsQueryOptions = (
  runAuthed: RunAuthed
): UseSuspenseQueryOptions<
  readonly Client.Type[],
  Error,
  readonly Client.Type[],
  typeof CLIENTS_QUERY_KEY
> =>
  queryOptions({
    queryKey: CLIENTS_QUERY_KEY,
    queryFn: () =>
      runAuthed(
        Effect.flatMap(AuthorizationServerHttpApiClient, (c) =>
          c['access-management'].ListClients()
        )
      ),
    // Approving an unknown app (trust on first use) creates a client row from
    // the host's consent sheet, outside this React tree — refetch on mount so it shows
    // up, for the same reason the grants list does.
    refetchOnMount: 'always',
  })

/** Reads synchronously from cache when the route loader has already warmed it. */
const useClientsQuery = (): UseSuspenseQueryResult<readonly Client.Type[], Error> =>
  useSuspenseQuery(clientsQueryOptions(useRunAuthed()))

/** True for `UpdateClient`'s `409` for disabling an essential client. */
const isEssentialClient = (
  error: unknown
): error is Schema.Schema.Type<typeof AccessManagement.EssentialClientSchema> =>
  typeof error === 'object' &&
  error !== null &&
  'error' in error &&
  error.error === 'EssentialClient'

/**
 * A disable the server refused because the client is essential. Its message
 * is what the Owner reads where the switch's error renders.
 */
class EssentialClientDisableRefusal extends Data.TaggedError('EssentialClientDisableRefusal')<{
  readonly clientId: string
}> {
  override readonly message =
    'This client is essential. Disabling it would leave you no way into your server.'
}

/** `UpdateClient`'s input: the client, and which way to flip it. */
interface UpdateClientVariables {
  readonly clientId: string
  readonly action: ClientSwitch
}

/**
 * `UpdateClient` (PATCH). Disabling sends the current time from the Effect
 * `Clock` (the server stamps its own now whatever time arrives); enabling
 * sends `null`. The server's `409 EssentialClient` fails the mutation with
 * {@link EssentialClientDisableRefusal}. Invalidates the clients list.
 */
const useUpdateClientMutation = (): UseMutationResult<
  Client.Type,
  Error,
  UpdateClientVariables
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
        Effect.gen(function* () {
          const disabledAt = action === 'disable' ? yield* DateTime.now : null
          const client = yield* AuthorizationServerHttpApiClient
          return yield* client['access-management'].UpdateClient({ path, payload: { disabledAt } })
        }).pipe(
          Effect.catchIf(isEssentialClient, (refused) =>
            Effect.fail(new EssentialClientDisableRefusal({ clientId: refused.clientId }))
          )
        )
      )
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CLIENTS_QUERY_KEY })
    },
  })
}

export {
  clientsQueryOptions,
  EssentialClientDisableRefusal,
  useClientsQuery,
  useUpdateClientMutation,
}
export type { ClientSwitch, UpdateClientVariables }
