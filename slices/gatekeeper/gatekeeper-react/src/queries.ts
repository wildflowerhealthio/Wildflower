import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { AccessManagement, Devices, OAuthConsent } from 'gatekeeper-core/http-api-definition'

import type { RouterContext, RunAuthed } from './router-context.ts'

// Annotated `select` so the result stays typed when the slice's router
// isn't registered (standalone build) — without a registered Router,
// `useRouteContext()` widens to `any`; the explicit `(context: RouterContext)`
// annotation re-narrows it with no cast.
const useRunAuthed = (): RunAuthed =>
  useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runAuthed })

type Grant = Schema.Schema.Type<typeof AccessManagement.GrantSchema>
type HttpRequest = Schema.Schema.Type<typeof AccessManagement.HttpRequestSchema>
type DeviceConsent = Schema.Schema.Type<typeof Devices.DeviceConsentSchema>
type OAuthConsentResource = Schema.Schema.Type<typeof OAuthConsent.OAuthConsentSchema>
type DeviceConsentResult = Schema.Schema.Type<typeof Devices.DeviceConsentResultSchema>
type OAuthConsentResult = Schema.Schema.Type<typeof OAuthConsent.OAuthConsentResultSchema>

type ApproveOAuthPayload = {
  readonly approvedScopes: readonly string[]
  readonly patient: string | null
}

// Query-key roots. Mutations invalidate the matching root so the next
// render refetches. List + detail share a root so a decision on one
// request (or grant) invalidates both surfaces.
const GRANTS_QUERY_KEY = ['gatekeeper', 'grants'] as const
const grantQueryKey = (id: string): readonly [string, string, string] => ['gatekeeper', 'grant', id]
const REQUESTS_QUERY_KEY = ['gatekeeper', 'requests'] as const
const requestQueryKey = (id: string): readonly [string, string, string] => [
  'gatekeeper',
  'request',
  id,
]
const deviceConsentQueryKey = (userCode: string): readonly [string, string, string] => [
  'gatekeeper',
  'device-consent',
  userCode,
]
const oauthConsentQueryKey = (id: string): readonly [string, string, string] => [
  'gatekeeper',
  'oauth-consent',
  id,
]

// ---------------------------------------------------------------------------
// Access-management: grants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Access-management: requests
// ---------------------------------------------------------------------------

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

type RequestDecision = 'approved' | 'rejected'

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

// ---------------------------------------------------------------------------
// Devices (device-authorization consent)
// ---------------------------------------------------------------------------

/** Shared by the route `loader` and {@link useDeviceConsentQuery}. */
const deviceConsentQueryOptions = (
  runAuthed: RunAuthed,
  userCode: string
): UseSuspenseQueryOptions<
  DeviceConsent,
  Error,
  DeviceConsent,
  readonly [string, string, string]
> =>
  queryOptions({
    queryKey: deviceConsentQueryKey(userCode),
    queryFn: () =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          c.devices.GetDeviceConsent({ path: { userCode } })
        )
      ),
  })

const useDeviceConsentQuery = (userCode: string): UseSuspenseQueryResult<DeviceConsent, Error> =>
  useSuspenseQuery(deviceConsentQueryOptions(useRunAuthed(), userCode))

/** `ApproveDeviceConsent` / `DenyDeviceConsent`. Returns the resulting decision. */
const useDeviceConsentMutation = (): UseMutationResult<
  DeviceConsentResult,
  Error,
  | {
      readonly kind: 'approve'
      readonly userCode: string
      readonly approvedScopes: readonly string[]
    }
  | { readonly kind: 'deny'; readonly userCode: string }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (variables) =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          variables.kind === 'approve'
            ? c.devices.ApproveDeviceConsent({
                path: { userCode: variables.userCode },
                payload: { approvedScopes: [...variables.approvedScopes] },
              })
            : c.devices.DenyDeviceConsent({ path: { userCode: variables.userCode } })
        )
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: deviceConsentQueryKey(variables.userCode) })
    },
  })
}

// ---------------------------------------------------------------------------
// OAuth consent
// ---------------------------------------------------------------------------

/** Shared by the route `loader` and {@link useOAuthConsentQuery}. */
const oauthConsentQueryOptions = (
  runAuthed: RunAuthed,
  id: string
): UseSuspenseQueryOptions<
  OAuthConsentResource,
  Error,
  OAuthConsentResource,
  readonly [string, string, string]
> =>
  queryOptions({
    queryKey: oauthConsentQueryKey(id),
    queryFn: () =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          c['oauth-consent'].GetOAuthConsent({ path: { id } })
        )
      ),
  })

const useOAuthConsentQuery = (id: string): UseSuspenseQueryResult<OAuthConsentResource, Error> =>
  useSuspenseQuery(oauthConsentQueryOptions(useRunAuthed(), id))

/** `ApproveOAuthConsent` / `DenyOAuthConsent`. Returns the resulting decision. */
const useOAuthConsentMutation = (): UseMutationResult<
  OAuthConsentResult,
  Error,
  | { readonly kind: 'approve'; readonly id: string; readonly payload: ApproveOAuthPayload }
  | { readonly kind: 'deny'; readonly id: string }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (variables) =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          variables.kind === 'approve'
            ? c['oauth-consent'].ApproveOAuthConsent({
                path: { id: variables.id },
                payload: {
                  approvedScopes: [...variables.payload.approvedScopes],
                  patient: variables.payload.patient,
                },
              })
            : c['oauth-consent'].DenyOAuthConsent({ path: { id: variables.id } })
        )
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: oauthConsentQueryKey(variables.id) })
    },
  })
}

export {
  deviceConsentQueryOptions,
  GRANTS_QUERY_KEY,
  grantQueryOptions,
  grantsQueryOptions,
  oauthConsentQueryOptions,
  REQUESTS_QUERY_KEY,
  requestQueryOptions,
  requestsQueryOptions,
  useDecideRequestMutation,
  useDeviceConsentMutation,
  useDeviceConsentQuery,
  useGrantQuery,
  useGrantsQuery,
  useOAuthConsentMutation,
  useOAuthConsentQuery,
  useRequestQuery,
  useRequestsQuery,
  useRevokeGrantMutation,
  useRunAuthed,
}
export type {
  ApproveOAuthPayload,
  DeviceConsent,
  Grant,
  HttpRequest,
  OAuthConsentResource,
  RequestDecision,
  RunAuthed,
}
