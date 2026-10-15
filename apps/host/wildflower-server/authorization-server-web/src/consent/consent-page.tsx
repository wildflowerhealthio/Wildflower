import { HttpApiError, HttpClientError } from '@effect/platform'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { OAuthConsent } from '@wildflowerhealthio/authorization-core/http-api-definition'
import {
  consentAsksForPatient,
  oauthConsentMutationOptions,
  OAuthConsentCard,
  type AuthorizationRouterContext,
  type OAuthConsentMutation,
  type OAuthConsentResource,
  type OAuthConsentResult,
} from '@wildflowerhealthio/authorization-react'
import { useDebouncedCallback } from '@wildflowerhealthio/react-kitchen-sink'
import { ErrorBanner, PageLoading } from '@wildflowerhealthio/react-tundraish'
import { isInsufficientScopeBody } from '@wildflowerhealthio/shared-structures-core/http-api-definition'
import { Effect, Match, Option, Schema } from 'effect'
import { useEffect, useState, type JSX } from 'react'

import { followableClientCallback } from '../client-callback.ts'
import { DONE_MESSAGE } from '../then-query.ts'
import { searchPatientsByName } from './patient-search.ts'
import styles from './consent-page.module.css'

/** How long the name search waits after the last keystroke before it asks the server. */
const PATIENT_SEARCH_DELAY_MS = 300

/** What the page says when reading the request failed some other way. */
const REQUEST_UNREADABLE =
  "Couldn't read this request. Approve it on the device running your server instead."

/** What the page says once a decision has no callback it can leave for. */
const UNEXPECTED_ANSWER = 'The authorization server returned an unexpected answer.'

interface ConsentPageProps {
  /** The pending authorization request the page decides, read from its path. */
  readonly requestId: string
  /** The runner over the Owner browser's session (see `ownerBrowserSessionRunner`). */
  readonly runAuthed: AuthorizationRouterContext.RunAuthed
  /** The wait page for the same request, `…/authorize/{id}/wait`. */
  readonly waitPage: URL
  /** Leave the page for `destination`, replacing it in the browser's history. */
  readonly leaveFor: (destination: URL) => void
  /**
   * In `then=back` mode (see `goBackOnceDecidedOf`), the step back out of the
   * page once the Owner has decided, in place of the client callback: the
   * browser that made the request finishes the flow from its wait page.
   * `None` leaves for the callback.
   */
  readonly goBackOnceDecided: Option.Option<() => void>
}

/** Where the page stands once the Owner has decided. */
type Exit =
  | { readonly kind: 'leaving' }
  /** Decided in `then=back` mode: the page steps back out rather than leave for the callback. */
  | { readonly kind: 'done' }
  | { readonly kind: 'declined' }
  | { readonly kind: 'unexpected' }

/**
 * Whether a failed consent read means this browser can't decide the request
 * here, so the wait page should take over: it isn't signed in as the Owner
 * (`401`), its session can't read consents (`403`), or the request is no longer
 * pending (`404`: decided elsewhere, or expired, which the wait page reports).
 */
const isUndecidableHere = (error: unknown): boolean =>
  error instanceof HttpApiError.Unauthorized ||
  (error instanceof HttpClientError.ResponseError && error.response.status === 401) ||
  isInsufficientScopeBody(error) ||
  Schema.is(OAuthConsent.OAuthConsentNotFoundSchema)(error)

/**
 * The pending consent `requestId`, or `None` when this browser can't decide it
 * here (see {@link isUndecidableHere}).
 */
const consentDecidableHere = (
  requestId: string
): Effect.Effect<Option.Option<OAuthConsentResource>, unknown, AuthorizationServerHttpApiClient> =>
  Effect.flatMap(AuthorizationServerHttpApiClient, (client) =>
    client['oauth-consent'].GetOAuthConsent({ path: { id: requestId } })
  ).pipe(
    Effect.map(Option.some),
    Effect.catchIf(isUndecidableHere, () => Effect.succeed(Option.none()))
  )

/**
 * The consent card on the authorization server's own origin, for the browser
 * signed in as the Owner: it reads the pending request, lets the Owner narrow
 * and decide it, and leaves for the client callback the decision's answer
 * carries, or, in `then=back` mode, says it is done and steps back out of the
 * page. A browser that can't decide the request here goes to the wait page
 * instead.
 *
 * @remarks
 * Everything goes through `runAuthed` on the Owner browser's session: the
 * consent read and the decision through the authorization API, and the
 * patient search through FHIR `GET /Patient`, so the search lists exactly the
 * patients the Owner's token may read.
 */
const ConsentPage = ({
  requestId,
  runAuthed,
  waitPage,
  leaveFor,
  goBackOnceDecided,
}: ConsentPageProps): JSX.Element => {
  const consentQuery = useQuery({
    queryKey: ['consent-page', 'oauth-consent', requestId],
    queryFn: () => runAuthed(consentDecidableHere(requestId)),
    // The read is the page's first; a retry only delays the wait page.
    retry: false,
  })
  const consentMutation = useMutation(oauthConsentMutationOptions(runAuthed))
  const [exit, setExit] = useState<Exit | null>(null)

  const undecidableHere = consentQuery.data !== undefined && Option.isNone(consentQuery.data)
  useEffect(() => {
    if (undecidableHere) leaveFor(waitPage)
  }, [undecidableHere, leaveFor, waitPage])

  // Step back out only once the done message is on screen, so a window the
  // browser refuses to close still says the decision went through.
  const done = exit?.kind === 'done'
  useEffect(() => {
    if (done && Option.isSome(goBackOnceDecided)) goBackOnceDecided.value()
  }, [done, goBackOnceDecided])

  const leaveWith = (result: OAuthConsentResult): void => {
    if (result.status !== 'error' && Option.isSome(goBackOnceDecided)) {
      setExit({ kind: 'done' })
      return
    }
    const redirect = result.status === 'error' ? undefined : result.redirect
    if (redirect === undefined) {
      setExit({ kind: result.status === 'denied' ? 'declined' : 'unexpected' })
      return
    }
    Option.match(followableClientCallback(redirect), {
      onNone: () => {
        setExit({ kind: 'unexpected' })
      },
      onSome: (callback) => {
        setExit({ kind: 'leaving' })
        leaveFor(callback)
      },
    })
  }

  if (exit !== null) return <ConsentExit exit={exit} />
  if (consentQuery.isError) {
    return <p className={styles['consent-page__message']}>{REQUEST_UNREADABLE}</p>
  }
  return (
    consentQuery.data?.pipe(
      Option.map((consent) => (
        <DecidableConsent
          key={consent.id}
          consent={consent}
          consentMutation={consentMutation}
          runAuthed={runAuthed}
          onDone={leaveWith}
        />
      )),
      Option.getOrNull
    ) ?? <PageLoading message="Loading the request…" />
  )
}

interface DecidableConsentProps {
  readonly consent: OAuthConsentResource
  readonly consentMutation: OAuthConsentMutation
  readonly runAuthed: AuthorizationRouterContext.RunAuthed
  readonly onDone: (result: OAuthConsentResult) => void
}

/**
 * The card for a consent this browser can decide, with the patient search the
 * card shows when the request asks for a patient.
 */
const DecidableConsent = ({
  consent,
  consentMutation,
  runAuthed,
  onDone,
}: DecidableConsentProps): JSX.Element => {
  const asksForPatient = consentAsksForPatient(consent)
  const [patientName, setPatientName] = useState('')
  const [searchedName, setSearchedName] = useState('')
  const searchName = useDebouncedCallback(setSearchedName, PATIENT_SEARCH_DELAY_MS)
  const patientsQuery = useQuery({
    queryKey: ['consent-page', 'patients', searchedName],
    queryFn: () => runAuthed(searchPatientsByName(searchedName)),
    enabled: asksForPatient,
    // Keep the last matches on screen while the next search is in flight.
    placeholderData: keepPreviousData,
  })
  return (
    <OAuthConsentCard
      consent={consent}
      consentMutation={consentMutation}
      patients={{
        options: patientsQuery.data ?? [],
        loading: asksForPatient && patientsQuery.isLoading,
        error: patientsQuery.error,
      }}
      patientSearch={{
        name: patientName,
        onNameChange: (name) => {
          setPatientName(name)
          searchName.call(name)
        },
      }}
      onDone={onDone}
    />
  )
}

/** What the page shows once the Owner has decided. */
const ConsentExit = ({ exit }: { readonly exit: Exit }): JSX.Element =>
  Match.value(exit).pipe(
    Match.discriminatorsExhaustive('kind')({
      leaving: () => <p className={styles['consent-page__message']}>Returning you to the app…</p>,
      done: () => <p className={styles['consent-page__message']}>{DONE_MESSAGE}</p>,
      declined: () => <p className={styles['consent-page__message']}>The request was declined.</p>,
      unexpected: () => <ErrorBanner error={new Error(UNEXPECTED_ANSWER)} />,
    })
  )

export { ConsentPage }
export type { ConsentPageProps }
