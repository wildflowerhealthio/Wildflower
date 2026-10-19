import { HttpClientError } from '@effect/platform'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { OAuth } from '@wildflowerhealthio/authorization-core/http-api-definition'
import type { AuthorizationRouterContext } from '@wildflowerhealthio/authorization-react'
import { PageHeader, PageLoading } from '@wildflowerhealthio/react-tundraish'
import { Scope } from '@wildflowerhealthio/scopes-core'
import { fluentScope } from '@wildflowerhealthio/scopes-react'
import { Effect, Option, Schema } from 'effect'
import { useEffect, type JSX } from 'react'

import { followableClientCallback } from '../client-callback.ts'
import styles from './limited-page.module.css'

/** What the page says when reading the request failed some other way. */
const REQUEST_UNREADABLE = "Couldn't read this request. Go back to the app and try again."

/** What the page says when Continue or Cancel failed some other way. */
const ANSWER_FAILED = "Couldn't finish this request. Go back to the app and try again."

/** What the page says when the authorization start limit refused Continue. */
const START_LIMITED =
  'This server has had too many sign-in requests. Wait a few minutes, then press Continue again.'

/** What the limited page says, as `GET …/session-shortfall` answers it. */
type SessionShortfall = typeof OAuth.SessionShortfallSchema.Type

/** What reading the request answered. */
type ShortfallLookup =
  | { readonly kind: 'waiting'; readonly shortfall: SessionShortfall }
  /** The request no longer waits on this page: decided, expired, or another browser's. */
  | { readonly kind: 'gone' }

/** What Continue or Cancel answered. */
type ShortfallAnswer =
  /** Where the server sends the browser next. */
  | { readonly kind: 'next'; readonly location: string }
  /** The request no longer waits on this page. */
  | { readonly kind: 'gone' }
  /** The authorization start limit refused Continue; the request still waits. */
  | { readonly kind: 'start-limited' }

/** Whether `error` is the start limit's `429`. */
const isStartLimited = (error: unknown): boolean =>
  error instanceof HttpClientError.ResponseError && error.response.status === 429

/** The request `requestId` as this browser's limited page reads it. */
const lookUpShortfall = (
  requestId: string
): Effect.Effect<ShortfallLookup, unknown, AuthorizationServerHttpApiClient> =>
  Effect.flatMap(AuthorizationServerHttpApiClient, (client) =>
    client.oauth.SessionShortfall({ path: { id: requestId } })
  ).pipe(
    Effect.map((shortfall): ShortfallLookup => ({ kind: 'waiting', shortfall })),
    Effect.catchIf(Schema.is(OAuth.AuthorizationStatusNotFoundSchema), () =>
      Effect.succeed<ShortfallLookup>({ kind: 'gone' })
    )
  )

/** Continue past, or cancel, the request `requestId`. */
const answerShortfall = (
  requestId: string,
  action: 'continue' | 'cancel'
): Effect.Effect<ShortfallAnswer, unknown, AuthorizationServerHttpApiClient> =>
  Effect.flatMap(AuthorizationServerHttpApiClient, (client) =>
    action === 'continue'
      ? client.oauth.SessionShortfallContinue({ path: { id: requestId } })
      : client.oauth.SessionShortfallCancel({ path: { id: requestId } })
  ).pipe(
    Effect.map(({ location }): ShortfallAnswer => ({ kind: 'next', location })),
    Effect.catchIf(Schema.is(OAuth.AuthorizationStatusNotFoundSchema), () =>
      Effect.succeed<ShortfallAnswer>({ kind: 'gone' })
    ),
    Effect.catchIf(isStartLimited, () => Effect.succeed<ShortfallAnswer>({ kind: 'start-limited' }))
  )

/**
 * A missing scope in words that finish "This browser isn't allowed to …": the
 * resource scope's verbs and records ("read Observations"), else the known
 * scope's own explanation ("launch apps you have access to"), else the scope
 * itself.
 */
const scopePhrase = (scope: string): string => {
  const fluent = fluentScope(scope)
  if (fluent !== null) return fluent
  const parsed = Scope.parse(scope)
  if (parsed instanceof Scope.Known) {
    const explanation = parsed.plainExplanation()
    return explanation.charAt(0).toLowerCase() + explanation.slice(1)
  }
  return scope
}

/** `phrases` joined into a running list: "a", "a and b", "a, b, and c". */
const listOf = (phrases: readonly string[]): string =>
  new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(phrases)

interface LimitedPageProps {
  /** The pending authorization request the page is for, read from its path. */
  readonly requestId: string
  /** The runner over the browser session (see `browserSessionRunner`). */
  readonly runAuthed: AuthorizationRouterContext.RunAuthed
  /** The wait page for the same request, `…/authorize/{id}/wait`. */
  readonly waitPage: URL
  /** Leave the page for `destination`, replacing it in the browser's history. */
  readonly leaveFor: (destination: URL) => void
}

/**
 * The limited page, `/oauth/authorize/{id}/limited`, on the authorization
 * server's own origin: where `/oauth/authorize` sends a browser whose session
 * holds less than the app asks for. It names what this browser isn't allowed
 * to do, then **Continue** goes on (to the app with a narrowed code, or to the
 * consent card or the wait page) and **Cancel** sends the browser back to the
 * app with `access_denied`; either way it leaves for where the server's answer
 * says. A request no longer waiting here (decided, expired, or not this
 * browser's) goes to the wait page, which says how it ended.
 */
const LimitedPage = ({
  requestId,
  runAuthed,
  waitPage,
  leaveFor,
}: LimitedPageProps): JSX.Element => {
  const shortfallQuery = useQuery({
    queryKey: ['limited-page', 'session-shortfall', requestId],
    queryFn: () => runAuthed(lookUpShortfall(requestId)),
    retry: false,
  })
  const answerMutation = useMutation({
    mutationFn: async (action: 'continue' | 'cancel'): Promise<ShortfallAnswer> => {
      const answer = await runAuthed(answerShortfall(requestId, action))
      if (answer.kind !== 'next') return answer
      // A path on this server (the consent card, the wait page) resolves
      // against it; the client callback is absolute. Only http(s) is followed.
      return Option.match(followableClientCallback(new URL(answer.location, waitPage).href), {
        onNone: () => {
          throw new Error(`unfollowable location ${answer.location}`)
        },
        onSome: (destination) => ({ kind: 'next', location: destination.href }),
      })
    },
    onSuccess: (answer) => {
      if (answer.kind === 'gone') leaveFor(waitPage)
      if (answer.kind === 'next') leaveFor(new URL(answer.location))
    },
  })

  const gone = shortfallQuery.data?.kind === 'gone'
  useEffect(() => {
    if (gone) leaveFor(waitPage)
  }, [gone, leaveFor, waitPage])

  const view = ((): JSX.Element => {
    if (shortfallQuery.isError) {
      return <p className={styles['limited-page__message']}>{REQUEST_UNREADABLE}</p>
    }
    if (shortfallQuery.data?.kind !== 'waiting') {
      return <PageLoading message="Loading the request…" />
    }
    const { clientName, missingScopes } = shortfallQuery.data.shortfall
    const answered = answerMutation.data
    const failure = ((): string | null => {
      if (answerMutation.isError) return ANSWER_FAILED
      if (answered?.kind === 'start-limited') return START_LIMITED
      return null
    })()
    const leaving =
      answerMutation.isPending || answered?.kind === 'next' || answered?.kind === 'gone'
    return (
      <>
        <p className={styles['limited-page__message']}>
          This browser isn&apos;t allowed to {listOf(missingScopes.map(scopePhrase))}, which{' '}
          {clientName} expects. {clientName} may not be able to do everything.
        </p>
        {failure === null ? null : (
          <p role="alert" className={styles['limited-page__message']}>
            {failure}
          </p>
        )}
        <div className={styles['limited-page__actions']}>
          <button
            type="button"
            className="button-2 outline"
            disabled={leaving}
            onClick={() => {
              answerMutation.mutate('cancel')
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button-2 filled"
            disabled={leaving}
            onClick={() => {
              answerMutation.mutate('continue')
            }}
          >
            Continue
          </button>
        </div>
      </>
    )
  })()

  return (
    <>
      <PageHeader title="Limited Access" />
      {view}
    </>
  )
}

export { LimitedPage }
export type { LimitedPageProps }
