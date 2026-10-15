import { HttpApiError, HttpClientError } from '@effect/platform'
import { useMutation } from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { Devices } from '@wildflowerhealthio/authorization-core/http-api-definition'
import {
  DeviceCodeEntryForm,
  DeviceConsentCard,
  deviceConsentMutationOptions,
  type AuthorizationRouterContext,
  type DeviceConsent,
  type DeviceConsentMutation,
  type DeviceConsentResult,
} from '@wildflowerhealthio/authorization-react'
import { PageHeader } from '@wildflowerhealthio/react-tundraish'
import { isInsufficientScopeBody } from '@wildflowerhealthio/shared-structures-core/http-api-definition'
import { Effect, Match, Schema } from 'effect'
import { useState, type JSX } from 'react'

import styles from './device-page.module.css'

/** What the page says when the code names no pending request. */
const UNKNOWN_CODE =
  'No device is waiting with this code. Check the code on your device; it may have expired.'

interface DevicePageProps {
  /** The code the page's query names, which fills the code box. */
  readonly initialUserCode: string
  /** The runner over the Owner browser's session (see `ownerBrowserSessionRunner`). */
  readonly runAuthed: AuthorizationRouterContext.RunAuthed
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
}

/**
 * The page before a decision, for the answer to the last confirmed code
 * (`undefined` before one): the code entry until a code names a request, then
 * the card, or where to decide instead.
 */
const requestView = (
  found: DeviceLookup | undefined,
  { codeEntry, consentMutation, onDone }: RequestViewParts
): JSX.Element =>
  found === undefined
    ? codeEntry
    : Match.value(found).pipe(
        Match.discriminatorsExhaustive('kind')({
          decidable: ({ consent }) => (
            <DeviceConsentCard
              key={consent.userCode}
              consent={consent}
              consentMutation={consentMutation}
              onDone={onDone}
            />
          ),
          'undecidable-here': () => (
            <p className={styles['device-page__message']}>
              Approve this on the device running your server.
            </p>
          ),
          'unknown-code': () => codeEntry,
        })
      )

/**
 * The RFC 8628 device verification page on the authorization server's own
 * origin. The Owner confirms the code the device shows (pre-filled from the
 * page's `user_code`, never sent on its own: RFC 8628 §5.4), then decides the
 * request on the device-consent card.
 *
 * @remarks
 * Everything goes through `runAuthed` on the Owner browser's session. What the
 * page shows follows the API's answers, not who the session is: a session that
 * can't read the request (`401`, `403`) is told to approve it on the device
 * running the server, and the request stays pending.
 */
const DevicePage = ({ initialUserCode, runAuthed }: DevicePageProps): JSX.Element => {
  // The read runs when the Owner confirms a code, not on render, so it is a
  // mutation: each confirmation is a fresh read with its own answer.
  const lookup = useMutation({
    mutationFn: (userCode: string) => runAuthed(lookUpDeviceConsent(userCode)),
  })
  const consentMutation = useMutation(deviceConsentMutationOptions(runAuthed))
  const [decision, setDecision] = useState<DeviceConsentResult | null>(null)

  const codeEntry = (
    <DeviceCodeEntryForm
      initialCode={initialUserCode}
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
  })
  return (
    <>
      <PageHeader title="Authorize Device" />
      {decision === null ? pendingView : <DeviceDecided decision={decision} />}
    </>
  )
}

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
