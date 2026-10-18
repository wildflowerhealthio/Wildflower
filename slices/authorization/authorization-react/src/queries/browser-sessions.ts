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
import { BROWSER_SESSIONS_QUERY_KEY } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

type BrowserSession = Schema.Schema.Type<typeof AccessManagement.BrowserSessionSchema>

/**
 * Shared by the route `loader` and {@link useBrowserSessionsQuery}. Browsers
 * sign in on the server's own pages, outside this React tree, and their
 * last-seen times move as they're used, so the access page's loader reads the
 * list afresh on every visit (`staleTime: 0`); the section then renders that
 * read without fetching again on mount.
 */
const browserSessionsQueryOptions = (
  runAuthed: RunAuthed
): UseSuspenseQueryOptions<
  readonly BrowserSession[],
  Error,
  readonly BrowserSession[],
  typeof BROWSER_SESSIONS_QUERY_KEY
> =>
  queryOptions({
    queryKey: BROWSER_SESSIONS_QUERY_KEY,
    queryFn: () =>
      runAuthed(
        Effect.flatMap(AuthorizationServerHttpApiClient, (c) =>
          c['access-management'].ListBrowserSessions()
        )
      ),
  })

/** Reads synchronously from cache when the route loader has already warmed it. */
const useBrowserSessionsQuery = (): UseSuspenseQueryResult<readonly BrowserSession[], Error> =>
  useSuspenseQuery(browserSessionsQueryOptions(useRunAuthed()))

/** `useRevokeBrowserSessionMutation`'s input: the session to end. */
interface RevokeBrowserSessionVariables {
  readonly sid: string
}

/**
 * `RevokeBrowserSession` (DELETE): end the session, and with it everything
 * minted under it. Invalidates the browsers list once it settles, on failure
 * too, so the list never keeps showing a session that ended.
 */
const useRevokeBrowserSessionMutation = (): UseMutationResult<
  void,
  Error,
  RevokeBrowserSessionVariables
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ sid }) =>
      runAuthed(
        Effect.flatMap(AuthorizationServerHttpApiClient, (c) =>
          c['access-management'].RevokeBrowserSession({ path: { sid } })
        )
      ),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: BROWSER_SESSIONS_QUERY_KEY })
    },
  })
}

export { browserSessionsQueryOptions, useBrowserSessionsQuery, useRevokeBrowserSessionMutation }
export type { BrowserSession, RevokeBrowserSessionVariables }
