import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { RelayAdminHttpApiClient } from '@wildflowerhealthio/relay-core-js/clients'
import type { Tunnels } from '@wildflowerhealthio/relay-core-js/http-api-definition'
import { Effect, type Schema } from 'effect'

import { useRelayAdmin } from '../relay-admin-context.ts'
import { CONNECTION_TOTALS_QUERY_KEY, TUNNELS_QUERY_KEY } from './keys.ts'

/** A tunnel as the relay lists it: no token. */
type TunnelInfo = Schema.Schema.Type<typeof Tunnels.TunnelInfoSchema>

/** What became of the last connection to a tunnel. */
type TunnelOutcome = Schema.Schema.Type<typeof Tunnels.TunnelOutcome>

/** One UTC hour's connections, by outcome. */
type ConnectionTotals = Schema.Schema.Type<typeof Tunnels.ConnectionTotalsSchema>

/** A tunnel just created or reissued, with its token, which the relay shows only now. */
type TunnelWithToken = Schema.Schema.Type<typeof Tunnels.TunnelWithTokenSchema>

/** A claim code just issued, which the relay shows only now, and its expiry. */
type IssuedClaimCode = Schema.Schema.Type<typeof Tunnels.IssuedClaimCodeSchema>

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
 * The hourly connection totals of the last 30 days. Like every query here it
 * refreshes when the page is focused again (TanStack Query's default); it is
 * not polled.
 */
const useConnectionTotalsQuery = (): UseQueryResult<readonly ConnectionTotals[]> => {
  const { run } = useRelayAdmin()
  return useQuery({
    queryKey: CONNECTION_TOTALS_QUERY_KEY,
    queryFn: () =>
      run(
        Effect.flatMap(RelayAdminHttpApiClient, (client) => client.tunnels.ListConnectionTotals())
      ),
  })
}

/**
 * `CreateTunnel`; refreshes the list. The result holds the token, so the
 * mutation cache drops it as soon as nothing shows it (`reset`, or the form
 * unmounting) rather than keeping it for the default five minutes.
 */
const useCreateTunnelMutation = (): UseMutationResult<TunnelWithToken, Error, CreateTunnelBody> => {
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

/**
 * `IssueClaimCode` for the tunnel of the given name. The result holds the
 * code, so, as with a created tunnel's token, the mutation cache drops it as
 * soon as nothing shows it.
 */
const useIssueClaimCodeMutation = (): UseMutationResult<IssuedClaimCode, Error, string> => {
  const { run } = useRelayAdmin()
  return useMutation({
    gcTime: 0,
    // `HttpApiClient` splices path params in raw.
    mutationFn: (name) =>
      run(
        Effect.flatMap(RelayAdminHttpApiClient, (client) =>
          client.tunnels.IssueClaimCode({ path: { name: encodeURIComponent(name) } })
        )
      ),
  })
}

/**
 * `IssueOpenClaimCode`. The result holds the code, so, as with a tunnel's,
 * the mutation cache drops it as soon as nothing shows it.
 */
const useIssueOpenClaimCodeMutation = (): UseMutationResult<IssuedClaimCode, Error, void> => {
  const { run } = useRelayAdmin()
  return useMutation({
    gcTime: 0,
    mutationFn: () =>
      run(Effect.flatMap(RelayAdminHttpApiClient, (client) => client.tunnels.IssueOpenClaimCode())),
  })
}

/**
 * `ReissueToken` for the tunnel of the given name. The result holds the new
 * token, so, as with a created tunnel's, the mutation cache drops it as soon
 * as nothing shows it.
 */
const useReissueTokenMutation = (): UseMutationResult<TunnelWithToken, Error, string> => {
  const { run } = useRelayAdmin()
  return useMutation({
    gcTime: 0,
    // `HttpApiClient` splices path params in raw.
    mutationFn: (name) =>
      run(
        Effect.flatMap(RelayAdminHttpApiClient, (client) =>
          client.tunnels.ReissueToken({ path: { name: encodeURIComponent(name) } })
        )
      ),
  })
}

export {
  useConnectionTotalsQuery,
  useCreateTunnelMutation,
  useDeleteTunnelMutation,
  useIssueClaimCodeMutation,
  useIssueOpenClaimCodeMutation,
  useReissueTokenMutation,
  useTunnelsQuery,
}
export type {
  ConnectionTotals,
  CreateTunnelBody,
  IssuedClaimCode,
  TunnelInfo,
  TunnelOutcome,
  TunnelWithToken,
}
