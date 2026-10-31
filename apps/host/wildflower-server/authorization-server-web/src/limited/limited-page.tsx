import { useMutation, useQuery } from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { OAuth, SessionWidenings } from '@wildflowerhealthio/authorization-core/http-api-definition'
import type { AuthorizationRouterContext } from '@wildflowerhealthio/authorization-react'
import { PageHeader, PageLoading } from '@wildflowerhealthio/react-tundraish'
import { Scope } from '@wildflowerhealthio/scopes-core'
import { fluentScope } from '@wildflowerhealthio/scopes-react'
import { Duration, Effect, Match, Option, Schema } from 'effect'
import { useEffect, type JSX } from 'react'

import { followableClientCallback } from '../client-callback.ts'
import styles from './limited-page.module.css'

/** What the page says when reading the request failed some other way. */
const REQUEST_UNREADABLE = "Couldn't read this request. Go back to the app and try again."

/** What the page says when Continue or Cancel failed some other way. */
const ANSWER_FAILED = "Couldn't finish this request. Go back to the app and try again."

/** What the page says while the server's owner decides whether to widen this browser's access. */
const WAITING_FOR_OWNER =
  "Asked the server's owner to let this browser do more. Waiting for their answer…"

/** What the page says when the server's owner declined to widen this browser's access. */
const OWNER_DECLINED = "The server's owner declined. This browser can do what it could before."

/** What the page says when the server's owner didn't decide in time. */
const OWNER_DID_NOT_ANSWER = "The server's owner didn't answer in time. You can ask again."

/** What the page says when asking the server's owner, or hearing back, failed some other way. */
const ASK_FAILED = "Couldn't ask the server's owner. Try again, or go on without asking."

/** How often the page asks whether the server's owner has decided. */
const WIDENING_POLL_INTERVAL = Duration.seconds(3)

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
    )
  )

/** What asking the server's owner to widen this browser's session answered. */
type WideningAsk =
  /** The widening the server filed, which the page polls. */
  | { readonly kind: 'asked'; readonly wideningId: string }
  /** The request no longer waits on this page. */
  | { readonly kind: 'gone' }

/** Where a widening stands, as the page's poll found it. */
type WideningStatus = (typeof OAuth.SessionWideningStatusSchema.Type)['status']

/** Ask the server's owner to widen this browser's session by what it lacks of `requestId`. */
const askToWiden = (
  requestId: string
): Effect.Effect<WideningAsk, unknown, AuthorizationServerHttpApiClient> =>
  Effect.flatMap(AuthorizationServerHttpApiClient, (client) =>
    client.oauth.AskToWidenSession({ path: { id: requestId } })
  ).pipe(
    Effect.map(({ wideningId }): WideningAsk => ({ kind: 'asked', wideningId })),
    Effect.catchIf(Schema.is(OAuth.AuthorizationStatusNotFoundSchema), () =>
      Effect.succeed<WideningAsk>({ kind: 'gone' })
    )
  )

/**
 * Where the widening `wideningId` stands. Once it is approved, this poll collects the wider
 * session: the server sets it as this browser's session cookie. A widening this browser can't
 * see any more has nothing more to collect, as an expired one.
 */
const pollWidening = (
  wideningId: string
): Effect.Effect<WideningStatus, unknown, AuthorizationServerHttpApiClient> =>
  Effect.flatMap(AuthorizationServerHttpApiClient, (client) =>
    client.oauth.SessionWideningPoll({ path: { id: wideningId } })
  ).pipe(
    Effect.map(({ status }) => status),
    Effect.catchIf(Schema.is(SessionWidenings.SessionWideningNotFoundSchema), () =>
      Effect.succeed<WideningStatus>('expired')
    )
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
  /** How often the page asks whether the server's owner has decided; three seconds by default. */
  readonly wideningPollInterval?: Duration.Duration
}

/**
 * The note above the buttons about asking the server's owner: waiting for them, their
 * decline, their silence, or a failure to ask; none before asking, or once they widened the
 * session (the page then reads what it still lacks).
 */
const wideningNoteOf = (asking: {
  /** Asking, or hearing back, failed. */
  readonly failed: boolean
  /** Asked, and the Owner hasn't decided yet. */
  readonly waiting: boolean
  /** What the last poll found, if one has answered. */
  readonly status: Option.Option<WideningStatus>
}): Option.Option<string> => {
  if (asking.failed) return Option.some(ASK_FAILED)
  if (asking.waiting) return Option.some(WAITING_FOR_OWNER)
  return asking.status.pipe(
    Option.flatMap((status) =>
      Match.value(status).pipe(
        Match.when('declined', () => Option.some(OWNER_DECLINED)),
        Match.when('expired', () => Option.some(OWNER_DID_NOT_ANSWER)),
        Match.whenOr('pending', 'widened', () => Option.none<string>()),
        Match.exhaustive
      )
    )
  )
}

/**
 * The limited page, `/oauth/authorize/{id}/limited`, on the authorization
 * server's own origin: where `/oauth/authorize` sends a browser whose session
 * holds less than the app asks for. It names what this browser isn't allowed
 * to do, then **Continue** goes on (to the app with a narrowed code, or to the
 * consent card or the wait page) and **Cancel** sends the browser back to the
 * app with `access_denied`; either way it leaves for where the server's answer
 * says. **Ask the server's owner** asks the Owner to widen this browser's
 * session by what it lacks, then polls until they decide: once they widen it,
 * the page reads what the session still lacks, and goes on at once when
 * that's nothing; a decline, or no answer in time, is said above the buttons.
 * A request no longer waiting here (decided, expired, or not this browser's)
 * goes to the wait page, which says how it ended. A request this browser's
 * session no longer falls short of (its grant was widened since) goes on at
 * once, with nothing to say.
 */
const LimitedPage = ({
  requestId,
  runAuthed,
  waitPage,
  leaveFor,
  wideningPollInterval = WIDENING_POLL_INTERVAL,
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

  const askMutation = useMutation({
    mutationFn: () => runAuthed(askToWiden(requestId)),
    onSuccess: (asked) => {
      if (asked.kind === 'gone') leaveFor(waitPage)
    },
  })
  const wideningId = askMutation.data?.kind === 'asked' ? askMutation.data.wideningId : null
  const wideningQuery = useQuery({
    queryKey: ['limited-page', 'session-widening', wideningId],
    queryFn: () => runAuthed(pollWidening(wideningId ?? '')),
    enabled: wideningId !== null,
    retry: false,
    refetchInterval: (query) =>
      query.state.data === 'pending' ? Duration.toMillis(wideningPollInterval) : false,
  })

  // The Owner widened this browser's session, and the poll collected it: read
  // what the session still lacks, which goes on at once when that's nothing.
  const widened = wideningQuery.data === 'widened'
  const { refetch: readShortfallAgain } = shortfallQuery
  const { reset: forgetAsking } = askMutation
  useEffect(() => {
    if (!widened) return
    forgetAsking()
    void readShortfallAgain()
  }, [widened, forgetAsking, readShortfallAgain])

  const gone = shortfallQuery.data?.kind === 'gone'
  useEffect(() => {
    if (gone) leaveFor(waitPage)
  }, [gone, leaveFor, waitPage])

  // The session lacks nothing the request asks for any more (its grant was
  // widened since the request parked), so there is nothing to say: go on.
  const lacksNothing =
    shortfallQuery.data?.kind === 'waiting' &&
    shortfallQuery.data.shortfall.missingScopes.length === 0
  const { mutate: answer, isIdle: unanswered } = answerMutation
  useEffect(() => {
    if (lacksNothing && unanswered) answer('continue')
  }, [lacksNothing, unanswered, answer])

  const view = ((): JSX.Element => {
    if (shortfallQuery.isError) {
      return <p className={styles['limited-page__message']}>{REQUEST_UNREADABLE}</p>
    }
    if (shortfallQuery.data?.kind !== 'waiting') {
      return <PageLoading message="Loading the request…" />
    }
    if (lacksNothing) {
      return answerMutation.isError ? (
        <p role="alert" className={styles['limited-page__message']}>
          {ANSWER_FAILED}
        </p>
      ) : (
        <PageLoading message="Continuing…" />
      )
    }
    const { clientName, missingScopes } = shortfallQuery.data.shortfall
    // Two scopes can read as the same words; each is said once.
    const phrases = [...new Set(missingScopes.map(scopePhrase))]
    const answered = answerMutation.data
    const failure = answerMutation.isError ? ANSWER_FAILED : null
    const leaving =
      answerMutation.isPending || answered?.kind === 'next' || answered?.kind === 'gone'
    // Asked, and the Owner hasn't decided: one ask at a time.
    const waitingForOwner =
      askMutation.isPending ||
      (wideningId !== null && (wideningQuery.isPending || wideningQuery.data === 'pending'))
    const wideningNote = wideningNoteOf({
      failed: askMutation.isError || wideningQuery.isError,
      waiting: waitingForOwner,
      status: Option.fromNullable(wideningQuery.data),
    })
    return (
      <>
        <p className={styles['limited-page__message']}>
          This browser isn&apos;t allowed to {listOf(phrases)}, which {clientName} expects.{' '}
          {clientName} may not be able to do everything.
        </p>
        {wideningNote.pipe(
          Option.map((note) => (
            <p key="widening-note" role="status" className={styles['limited-page__message']}>
              {note}
            </p>
          )),
          Option.getOrNull
        )}
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
            className="button-2 outline"
            disabled={leaving || waitingForOwner}
            onClick={() => {
              askMutation.mutate()
            }}
          >
            Ask the server&apos;s owner
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
