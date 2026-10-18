import { HttpApiError, HttpClientError } from '@effect/platform'
import { queryOptions, type UseQueryOptions } from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import type { AccessManagement } from '@wildflowerhealthio/authorization-core/http-api-definition'
import type { AuthorizationRouterContext } from '@wildflowerhealthio/authorization-react'
import { Effect, Option, type Schema } from 'effect'

type Session = Schema.Schema.Type<typeof AccessManagement.SessionSchema>

/** The session read's key, the same on every page. */
const SESSION_QUERY_KEY = ['session'] as const

/** Whether a failed read means this browser isn't signed in (`401`). */
const isSignedOut = (error: unknown): boolean =>
  error instanceof HttpApiError.Unauthorized ||
  (error instanceof HttpClientError.ResponseError && error.response.status === 401)

/**
 * The page's read of this browser's session, `GET /authorization/session` on
 * the browser session: `None` for a browser that isn't signed in. A page and
 * its `SessionFooter` share it under one key, so the page sends it once. One
 * read for the page's life: a refetch on focus could swap an open card for
 * another view and lose the Owner's draft. The read is the page's first; a
 * retry only delays the answer.
 */
const sessionQueryOptions = (
  runAuthed: AuthorizationRouterContext.RunAuthed
): UseQueryOptions<
  Option.Option<Session>,
  Error,
  Option.Option<Session>,
  typeof SESSION_QUERY_KEY
> =>
  queryOptions({
    queryKey: SESSION_QUERY_KEY,
    queryFn: () =>
      runAuthed(
        Effect.flatMap(AuthorizationServerHttpApiClient, (client) =>
          client['access-management'].GetSession()
        ).pipe(
          Effect.map(Option.some),
          Effect.catchIf(isSignedOut, () => Effect.succeed(Option.none()))
        )
      ),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })

export { isSignedOut, SESSION_QUERY_KEY, sessionQueryOptions }
export type { Session }
