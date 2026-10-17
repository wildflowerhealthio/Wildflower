import { HttpApiError, HttpClientError } from '@effect/platform'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { Devices } from '@wildflowerhealthio/authorization-core/http-api-definition'
import {
  DeviceCodeEntryForm,
  DeviceConsentCard,
  deviceConsentMutationOptions,
  ExpiredDeviceConsent,
  type AuthorizationRouterContext,
  type DeviceConsent,
  type DeviceConsentMutation,
  type DeviceConsentResult,
} from '@wildflowerhealthio/authorization-react'
import { unwrapFiberFailure } from '@wildflowerhealthio/kitchen-sink'
import { PageHeader, PageLoading } from '@wildflowerhealthio/react-tundraish'
import { Grant, Scope } from '@wildflowerhealthio/scopes-core'
import { isInsufficientScopeBody } from '@wildflowerhealthio/shared-structures-core/http-api-definition'
import { Effect, Match, Option, Schema } from 'effect'
import { useEffect, useState, type JSX } from 'react'

import { DecidedThenBack } from '../decided-then-back.tsx'

import { withoutUserCode } from './user-code-query.ts'
import styles from './device-page.module.css'

/**
 * What the page says when this browser can't decide device requests: the
 * request is decided on the device running the server, which notifies it.
 */
const APPROVE_ON_SERVER =
  "Approve this on the device running your server: open its notification, or the server's page in the Wildflower app."

/** What the page says when reading the session failed some other way. */
const SESSION_UNREADABLE =
  "Couldn't check this browser's session. Approve the request on the device running your server instead."

/** What the page says when the code names no pending request. */
const UNKNOWN_CODE =
  'No device is waiting with this code. Check the code on your device; it may have expired.'

interface DevicePageProps {
  /** The code the page's query names, which fills the code box. */
  readonly initialUserCode: string
  /** The runner over the browser session (see `browserSessionRunner`). */
  readonly runAuthed: AuthorizationRouterContext.RunAuthed
  /**
   * In `then=back` mode (see `goBackOnceDecidedOf`), the step back out of the
   * page once the Owner has decided, which then says it is done in place of
   * the decision's own message. `None` keeps the page on that message.
   */
  readonly goBackOnceDecided: Option.Option<() => void>
}

/** What reading the request a code names answered. */
type DeviceLookup =
  | { readonly kind: 'decidable'; readonly consent: DeviceConsent }
  /** This browser's session can't decide device requests here. */
  | { readonly kind: 'undecidable-here' }
  /** No pending request has the code: mistyped, decided, or expired. */
  | { readonly kind: 'unknown-code' }

/**
 * Whether a failed read means this browser can't decide the request here: it
 * isn't signed in (`401`), or its session can't read device consents (`403`).
 */
const isUndecidableHere = (error: unknown): boolean =>
  error instanceof HttpApiError.Unauthorized ||
  (error instanceof HttpClientError.ResponseError && error.response.status === 401) ||
  isInsufficientScopeBody(error)

/** The scopes the device routes need, as a grant to check a session against. */
const deviceConsentGrant = Grant.parse(Devices.DEVICE_CONSENT_SCOPES)

/**
 * Whether this browser's session can read and decide device requests here:
 * `GET /authorization/session` (authN-only) answers its scopes, which must
 * cover {@link Devices.DEVICE_CONSENT_SCOPES}. No session (`401`) can't.
 */
const sessionDecidesDevices: Effect.Effect<boolean, unknown, AuthorizationServerHttpApiClient> =
  Effect.flatMap(AuthorizationServerHttpApiClient, (client) =>
    client['access-management'].GetSession()
  ).pipe(
    Effect.map((session) =>
      Scope.MultiScope.within(deviceConsentGrant, Grant.parse(session.scopes))
    ),
    Effect.catchIf(isUndecidableHere, () => Effect.succeed(false))
  )

/** The pending device request `userCode` names, as a {@link DeviceLookup}. */
const lookUpDeviceConsent = (
  userCode: string
): Effect.Effect<DeviceLookup, unknown, AuthorizationServerHttpApiClient> =>
  Effect.flatMap(AuthorizationServerHttpApiClient, (client) =>
    client.devices.GetDeviceConsent({ path: { userCode } })
  ).pipe(
    Effect.map((consent): DeviceLookup => ({ kind: 'decidable', consent })),
    Effect.catchIf(isUndecidableHere, () =>
      Effect.succeed<DeviceLookup>({ kind: 'undecidable-here' })
    ),
    Effect.catchIf(Schema.is(Devices.DeviceConsentNotFoundSchema), () =>
      Effect.succeed<DeviceLookup>({ kind: 'unknown-code' })
    )
  )

interface RequestViewParts {
  /** The code entry, shown until a code names a request. */
  readonly codeEntry: JSX.Element
  readonly consentMutation: DeviceConsentMutation
  readonly onDone: (result: DeviceConsentResult) => void
  /** Back to an empty code entry, once the request has expired. */
  readonly onEnterNewCode: () => void
}

/**
 * The page for a request this browser can decide: the card, or, once the
 * decision has failed, where to decide instead (`401`, `403`) or that the
 * request expired, with the way back to the code entry.
 */
const decidableView = (
  consent: DeviceConsent,
  { consentMutation, onDone, onEnterNewCode }: RequestViewParts
): JSX.Element => {
  const decisionError = unwrapFiberFailure(consentMutation.error)
  if (isUndecidableHere(decisionError)) return <ApproveOnServer />
  if (decisionError instanceof ExpiredDeviceConsent) {
    return <ExpiredRequest expired={decisionError} onEnterNewCode={onEnterNewCode} />
  }
  return (
    <DeviceConsentCard
      key={consent.userCode}
      consent={consent}
      consentMutation={consentMutation}
      onDone={onDone}
    />
  )
}

/**
 * The page before a decision, for the answer to the last confirmed code
 * (`undefined` before one): the code entry until a code names a request, then
 * the card, or where to decide instead (see {@link decidableView}).
 */
const requestView = (found: DeviceLookup | undefined, parts: RequestViewParts): JSX.Element =>
  found === undefined
    ? parts.codeEntry
    : Match.value(found).pipe(
        Match.discriminatorsExhaustive('kind')({
          decidable: ({ consent }) => decidableView(consent, parts),
          'undecidable-here': () => <ApproveOnServer />,
          'unknown-code': () => parts.codeEntry,
        })
      )

/**
 * The RFC 8628 device verification page on the authorization server's own
 * origin. The Owner confirms the code the device shows (pre-filled from the
 * page's `user_code`, never sent on its own: RFC 8628 §5.4), then decides the
 * request on the device-consent card.
 *
 * @remarks
 * Everything goes through `runAuthed` on the browser session. What the
 * page shows follows the API's answers, not who the session is. On load it
 * reads the session's scopes: with none (`401`), or without the device
 * routes' scopes, it says to approve the request on the device running the
 * server and shows no code box. The same holds if a code's read, or the
 * decision, answers `401` or `403` later (the session can end in between).
 * Either way the request stays pending.
 *
 * In `then=back` mode a decision says how the Owner decided and steps back out
 * of the page, with a Close button that takes the step again.
 */
const DevicePage = ({
  initialUserCode,
  runAuthed,
  goBackOnceDecided,
}: DevicePageProps): JSX.Element => {
  const sessionQuery = useQuery({
    queryKey: ['device-page', 'session'],
    queryFn: () => runAuthed(sessionDecidesDevices),
    // One read for the page's life: a refetch on focus could swap an open
    // card for another view and lose the Owner's draft. The read is the
    // page's first; a retry only delays the answer.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
  // The read runs when the Owner confirms a code, not on render, so it is a
  // mutation: each confirmation is a fresh read with its own answer.
  const lookup = useMutation({
    mutationFn: (userCode: string) => runAuthed(lookUpDeviceConsent(userCode)),
  })
  const consentMutation = useMutation(deviceConsentMutationOptions(runAuthed))
  const [decision, setDecision] = useState<DeviceConsentResult | null>(null)
  // The code box's fill: the page's `user_code` until that code is spent.
  const [prefilledUserCode, setPrefilledUserCode] = useState(initialUserCode)

  // Step back out only once the decision is on screen, so a window the
  // browser refuses to close still says how it went.
  const decided = decision !== null
  useEffect(() => {
    if (decided && Option.isSome(goBackOnceDecided)) goBackOnceDecided.value()
  }, [decided, goBackOnceDecided])

  const enterNewCode = (): void => {
    lookup.reset()
    consentMutation.reset()
    setPrefilledUserCode('')
    window.history.replaceState(window.history.state, '', withoutUserCode(window.location.href))
  }

  const codeEntry = (
    <DeviceCodeEntryForm
      initialCode={prefilledUserCode}
      onSubmit={(userCode) => {
        lookup.mutate(userCode)
      }}
      error={lookup.data?.kind === 'unknown-code' ? UNKNOWN_CODE : lookup.error}
      submitting={lookup.isPending}
    />
  )

  const pendingView = requestView(lookup.data, {
    codeEntry,
    consentMutation,
    onDone: setDecision,
    onEnterNewCode: enterNewCode,
  })
  return (
    <>
      <PageHeader title="Authorize Device" />
      {decision === null ? (
        <SessionGate sessionQuery={sessionQuery}>{pendingView}</SessionGate>
      ) : (
        goBackOnceDecided.pipe(
          Option.map((goBack) => (
            <DecidedThenBack key="done" decision={decision.status} goBack={goBack} />
          )),
          Option.getOrElse(() => <DeviceDecided key="decided" decision={decision} />)
        )
      )}
    </>
  )
}

interface SessionGateProps {
  /** Whether this browser's session can decide device requests here. */
  readonly sessionQuery: {
    readonly data: boolean | undefined
    readonly isError: boolean
    readonly error: unknown
  }
  /** The page for a session that can. */
  readonly children: JSX.Element
}

/**
 * The page once the session is known to decide device requests here, or why
 * not. Only the first answer gates: once there is one, a later failed read
 * leaves the page as it is. A read that failed other than as `401` or `403`
 * says so in plain words, never with the error's own text.
 */
const SessionGate = ({ sessionQuery, children }: SessionGateProps): JSX.Element => {
  if (sessionQuery.data !== undefined) return sessionQuery.data ? children : <ApproveOnServer />
  if (sessionQuery.isError) {
    return <p className={styles['device-page__message']}>{SESSION_UNREADABLE}</p>
  }
  return <PageLoading message="Checking your session…" />
}

/** Where to decide when this browser can't. */
const ApproveOnServer = (): JSX.Element => (
  <p className={styles['device-page__message']}>{APPROVE_ON_SERVER}</p>
)

interface ExpiredRequestProps {
  readonly expired: ExpiredDeviceConsent
  readonly onEnterNewCode: () => void
}

/** A request that expired before the decision, and the way to a new code. */
const ExpiredRequest = ({ expired, onEnterNewCode }: ExpiredRequestProps): JSX.Element => (
  <>
    <p className={styles['device-page__message']}>{expired.message}</p>
    <div className={styles['device-page__actions']}>
      <button type="button" className="button-2 filled" onClick={onEnterNewCode}>
        Enter a new code
      </button>
    </div>
  </>
)

/** What the page shows once the Owner has decided. */
const DeviceDecided = ({ decision }: { readonly decision: DeviceConsentResult }): JSX.Element =>
  Match.value(decision).pipe(
    Match.discriminatorsExhaustive('status')({
      approved: () => (
        <p className={styles['device-page__message']}>
          The device is approved. You can return to it now.
        </p>
      ),
      denied: () => <p className={styles['device-page__message']}>The request was declined.</p>,
    })
  )

export { DevicePage }
export type { DevicePageProps }
