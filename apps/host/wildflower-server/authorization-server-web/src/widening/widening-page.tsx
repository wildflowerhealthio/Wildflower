import { useMutation, useQuery } from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { SessionWidenings } from '@wildflowerhealthio/authorization-core/http-api-definition'
import {
  SessionWideningCard,
  sessionWideningMutationOptions,
  type AuthorizationRouterContext,
  type SessionWideningConsent,
  type SessionWideningMutation,
  type SessionWideningResult,
} from '@wildflowerhealthio/authorization-react'
import { unwrapFiberFailure } from '@wildflowerhealthio/kitchen-sink'
import { PageHeader, PageLoading } from '@wildflowerhealthio/react-tundraish'
import { isInsufficientScopeBody } from '@wildflowerhealthio/shared-structures-core/http-api-definition'
import { Effect, Match, Option, Schema } from 'effect'
import { useEffect, useState, type JSX } from 'react'

import { DecidedThenBack } from '../decided-then-back.tsx'
import { isSignedOut } from '../session-query.ts'
import styles from './widening-page.module.css'

/**
 * What the page says when this browser can't decide the widening: it is
 * decided on the device running the server, which notifies it.
 */
const APPROVE_ON_SERVER =
  "Approve this on the device running your server: open its notification, or the server's page in the Wildflower app."

/** What the page says when the widening is no longer pending. */
const NO_LONGER_PENDING = 'This request was already decided or has expired.'

/** What the page says when reading the widening failed some other way. */
const WIDENING_UNREADABLE =
  "Couldn't read this request. Approve it on the device running your server instead."

/** What reading the widening answered. */
type WideningLookup =
  | { readonly kind: 'decidable'; readonly consent: SessionWideningConsent }
  /**
   * This browser's session can't decide the widening here: it isn't signed
   * in, can't read requests, or lacks the approval scopes.
   */
  | { readonly kind: 'undecidable-here' }
  /** The widening is no longer pending: decided, or expired. */
  | { readonly kind: 'gone' }

/** Whether a failed read or decision means this browser can't decide the widening here. */
const isUndecidableHere = (error: unknown): boolean =>
  isSignedOut(error) || isInsufficientScopeBody(error)

/** The pending widening `wideningId`, as a {@link WideningLookup}. */
const lookUpWidening = (
  wideningId: string
): Effect.Effect<WideningLookup, unknown, AuthorizationServerHttpApiClient> =>
  Effect.flatMap(AuthorizationServerHttpApiClient, (client) =>
    client.sessionWidenings.GetSessionWidening({ path: { id: wideningId } })
  ).pipe(
    Effect.map((consent): WideningLookup =>
      consent.missingApprovalScopes.length === 0
        ? { kind: 'decidable', consent }
        : { kind: 'undecidable-here' }
    ),
    Effect.catchIf(isUndecidableHere, () =>
      Effect.succeed<WideningLookup>({ kind: 'undecidable-here' })
    ),
    Effect.catchIf(Schema.is(SessionWidenings.SessionWideningNotFoundSchema), () =>
      Effect.succeed<WideningLookup>({ kind: 'gone' })
    )
  )

interface LookupViewParts {
  readonly consentMutation: SessionWideningMutation
  readonly onDone: (result: SessionWideningResult) => void
  /** What the page says once the widening is settled, by how. */
  readonly settledView: (settledAs: 'approved' | 'denied' | 'elsewhere') => JSX.Element
}

/** The page for what reading the widening answered: the card, or why not. */
const lookupView = (
  lookup: WideningLookup,
  { consentMutation, onDone, settledView }: LookupViewParts
): JSX.Element =>
  Match.value(lookup).pipe(
    Match.discriminatorsExhaustive('kind')({
      decidable: ({ consent }) => (
        <SessionWideningCard consent={consent} consentMutation={consentMutation} onDone={onDone} />
      ),
      'undecidable-here': () => (
        <p className={styles['widening-page__message']}>{APPROVE_ON_SERVER}</p>
      ),
      gone: () => settledView('elsewhere'),
    })
  )

interface WideningPageProps {
  /** The widening the page is for, read from its path. */
  readonly wideningId: string
  /** The runner over the browser session (see `browserSessionRunner`). */
  readonly runAuthed: AuthorizationRouterContext.RunAuthed
  /**
   * In `then=back` mode (see `goBackOnceDecidedOf`), the step back out of the
   * page once the widening is settled, which then says it is done in place of
   * the decision's own message. `None` keeps the page on that message.
   */
  readonly goBackOnceDecided: Option.Option<() => void>
}

/**
 * A session widening's card page, `/oauth/session-widenings/{id}/consent`, on
 * the authorization server's own origin: where the Owner decides a paired
 * browser's ask to widen its session. The host opens it from its notification,
 * signed in as the Owner, with `then=back`.
 *
 * @remarks
 * Everything goes through `runAuthed` on the browser session. A browser that
 * can't decide the widening (`401`, `403`, or approval scopes it lacks) is told
 * to approve it on the server's device; one no longer pending says so. The
 * browser that asked collects the decision on its own limited page, so this
 * page leaves for nothing: in `then=back` mode it says how it went and steps
 * back out.
 */
const WideningPage = ({
  wideningId,
  runAuthed,
  goBackOnceDecided,
}: WideningPageProps): JSX.Element => {
  const lookupQuery = useQuery({
    queryKey: ['widening-page', wideningId],
    queryFn: () => runAuthed(lookUpWidening(wideningId)),
    retry: false,
  })
  const consentMutation = useMutation(sessionWideningMutationOptions(runAuthed))
  const [decision, setDecision] = useState<SessionWideningResult | null>(null)

  // A widening settled before the page could decide it counts as settled
  // elsewhere; either way, in `then=back` mode the page steps back out once it
  // says so.
  const settled =
    decision !== null ||
    lookupQuery.data?.kind === 'gone' ||
    Schema.is(SessionWidenings.SessionWideningNotFoundSchema)(
      unwrapFiberFailure(consentMutation.error)
    )
  useEffect(() => {
    if (settled && Option.isSome(goBackOnceDecided)) goBackOnceDecided.value()
  }, [settled, goBackOnceDecided])

  const settledView = (settledAs: 'approved' | 'denied' | 'elsewhere'): JSX.Element =>
    goBackOnceDecided.pipe(
      Option.map((goBack) => <DecidedThenBack key="done" decision={settledAs} goBack={goBack} />),
      Option.getOrElse(() => (
        <p key="settled" className={styles['widening-page__message']}>
          {Match.value(settledAs).pipe(
            Match.when('approved', () => 'Approved. The browser can do more once it goes on.'),
            Match.when('denied', () => 'The request was declined.'),
            Match.when('elsewhere', () => NO_LONGER_PENDING),
            Match.exhaustive
          )}
        </p>
      ))
    )

  const decisionError = unwrapFiberFailure(consentMutation.error)
  const view = ((): JSX.Element => {
    if (decision !== null) return settledView(decision.status)
    if (isUndecidableHere(decisionError)) {
      return <p className={styles['widening-page__message']}>{APPROVE_ON_SERVER}</p>
    }
    if (Schema.is(SessionWidenings.SessionWideningNotFoundSchema)(decisionError)) {
      return settledView('elsewhere')
    }
    if (lookupQuery.isError) {
      return <p className={styles['widening-page__message']}>{WIDENING_UNREADABLE}</p>
    }
    if (lookupQuery.data === undefined) return <PageLoading message="Loading the request…" />
    return lookupView(lookupQuery.data, { consentMutation, onDone: setDecision, settledView })
  })()

  return (
    <>
      <PageHeader title="Widen Access" />
      {view}
    </>
  )
}

export { WideningPage }
export type { WideningPageProps }
