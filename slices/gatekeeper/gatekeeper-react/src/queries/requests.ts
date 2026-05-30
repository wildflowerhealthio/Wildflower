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
import { REQUESTS_QUERY_KEY, requestQueryKey } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

type HttpRequest = Schema.Schema.Type<typeof AccessManagement.HttpRequestSchema>
type RequestDecision = 'approved' | 'rejected'

/** Shared by the route `loader` and {@link useRequestsQuery}. */
const requestsQueryOptions = (
  runAuthed: RunAuthed
): UseSuspenseQueryOptions<
  readonly HttpRequest[],
  Error,
  readonly HttpRequest[],
  typeof REQUESTS_QUERY_KEY
> =>
  queryOptions({
    queryKey: REQUESTS_QUERY_KEY,
    queryFn: () =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) => c['access-management'].ListRequests())
      ),
  })

const useRequestsQuery = (): UseSuspenseQueryResult<readonly HttpRequest[], Error> =>
  useSuspenseQuery(requestsQueryOptions(useRunAuthed()))

/** Shared by the route `loader` and {@link useRequestQuery}. */
const requestQueryOptions = (
  runAuthed: RunAuthed,
  id: string
): UseSuspenseQueryOptions<HttpRequest, Error, HttpRequest, readonly [string, string, string]> =>
  queryOptions({
    queryKey: requestQueryKey(id),
    queryFn: () =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          c['access-management'].GetRequest({ path: { id } })
        )
      ),
  })

const useRequestQuery = (id: string): UseSuspenseQueryResult<HttpRequest, Error> =>
  useSuspenseQuery(requestQueryOptions(useRunAuthed(), id))

/** `ApproveRequest` / `DenyRequest`. Invalidates the requests list + the decided request's detail. */
const useDecideRequestMutation = (): UseMutationResult<
  unknown,
  Error,
  { readonly id: string; readonly decision: RequestDecision }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, decision }) =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          decision === 'approved'
            ? c['access-management'].ApproveRequest({ path: { id } })
            : c['access-management'].DenyRequest({ path: { id } })
        )
      ),
    onSuccess: async (_data, { id }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: requestQueryKey(id) }),
      ])
    },
  })
}

export {
  requestQueryOptions,
  requestsQueryOptions,
  useDecideRequestMutation,
  useRequestQuery,
  useRequestsQuery,
}
export type { HttpRequest, RequestDecision }
