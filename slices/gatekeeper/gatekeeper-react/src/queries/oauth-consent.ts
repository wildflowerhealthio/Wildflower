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
import type { OAuthConsent } from 'gatekeeper-core/http-api-definition'

import type { RunAuthed } from '../router-context.ts'
import { GRANTS_QUERY_KEY, oauthConsentQueryKey } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

type OAuthConsentResource = Schema.Schema.Type<typeof OAuthConsent.OAuthConsentSchema>
type OAuthConsentResult = Schema.Schema.Type<typeof OAuthConsent.OAuthConsentResultSchema>

type ApproveOAuthPayload = {
  readonly approvedScopes: readonly string[]
  readonly patient: string | null
}

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

/**
 * `ApproveOAuthConsent` / `DenyOAuthConsent`. Returns the resulting
 * decision.
 *
 * Like the device-consent mutation, the consent screen unmounts on
 * success (`onDone()` navigates to `/settings/gatekeeper`), so this
 * consent's own detail key is never re-read. Invalidate the grants list
 * root the user lands on so the new grant shows.
 */
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: GRANTS_QUERY_KEY })
    },
  })
}

export { oauthConsentQueryOptions, useOAuthConsentMutation, useOAuthConsentQuery }
export type { ApproveOAuthPayload, OAuthConsentResource }
