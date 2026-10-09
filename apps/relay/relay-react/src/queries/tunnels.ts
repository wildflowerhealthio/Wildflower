import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { Effect, type Schema } from 'effect'
import { RelayAdminHttpApiClient } from 'relay-core-js/clients'
import type { Tunnels } from 'relay-core-js/http-api-definition'

import { useRelayAdmin } from '../relay-admin-context.ts'
import { TUNNELS_QUERY_KEY } from './keys.ts'

/** A tunnel as the relay lists it: no token. */
type TunnelInfo = Schema.Schema.Type<typeof Tunnels.TunnelInfoSchema>

/** A tunnel just created, with its token, which the relay shows only now. */
type CreatedTunnel = Schema.Schema.Type<typeof Tunnels.CreatedTunnelSchema>

/** `CreateTunnel`'s body: an email, and a name unless the relay is to pick one. */
type CreateTunnelBody = Schema.Schema.Type<typeof Tunnels.CreateTunnelBodySchema>

/** Every tunnel on the relay. */
const useTunnelsQuery = (): UseQueryResult<readonly TunnelInfo[]> => {
  const { run } = useRelayAdmin()
  return useQuery({
    queryKey: TUNNELS_QUERY_KEY,
    queryFn: () =>
      run(Effect.flatMap(RelayAdminHttpApiClient, (client) => client.tunnels.ListTunnels())),
  })
}

/**
 * `CreateTunnel`; refreshes the list. The result holds the token, so the
 * mutation cache drops it as soon as nothing shows it (`reset`, or the form
 * unmounting) rather than keeping it for the default five minutes.
 */
const useCreateTunnelMutation = (): UseMutationResult<CreatedTunnel, Error, CreateTunnelBody> => {
  const { run } = useRelayAdmin()
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (payload) =>
      run(
        Effect.flatMap(RelayAdminHttpApiClient, (client) =>
          client.tunnels.CreateTunnel({ payload })
        )
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TUNNELS_QUERY_KEY })
    },
  })
}

/** `DeleteTunnel` by name; refreshes the list. */
const useDeleteTunnelMutation = (): UseMutationResult<void, Error, string> => {
  const { run } = useRelayAdmin()
  const queryClient = useQueryClient()
  return useMutation({
    // `HttpApiClient` splices path params in raw.
    mutationFn: (name) =>
      run(
        Effect.flatMap(RelayAdminHttpApiClient, (client) =>
          client.tunnels.DeleteTunnel({ path: { name: encodeURIComponent(name) } })
        )
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TUNNELS_QUERY_KEY })
    },
  })
}

export { useCreateTunnelMutation, useDeleteTunnelMutation, useTunnelsQuery }
export type { CreatedTunnel, CreateTunnelBody, TunnelInfo }
