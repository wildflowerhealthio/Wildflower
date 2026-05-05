import type { Store } from '@livestore/livestore'
import { DateTime } from 'effect'
import { timingSafeEqual } from '../internal/timing-safe-equal.ts'
import {
  AuthorizationCodes,
  AuthorizationRequests,
  PinChallenges,
  Sessions,
  SessionIdSchema,
  type SessionDuration,
  type schema,
} from '../livestore/index.ts'

type StoreHandle = Store<typeof schema, object>

const MAX_PIN_ATTEMPTS = 5

const sessionMaxAgeSeconds = (duration: SessionDuration): number => {
  if (duration === '15min') return 900
  if (duration === '1min') return 60
  return 30
}

/**
 * Mark an authorization request as approved, issue a single-use authorization
 * code, and return the redirect URL the OAuth client should be sent to.
 * Returns `null` when the request is not found.
 */
function approveAuthorizationRequest(
  store: StoreHandle,
  requestId: string,
  grantedScopes: readonly string[],
  patient?: string
): string | null {
  const pending = store.query(AuthorizationRequests.queries.byId$(requestId))
  if (pending == null) return null

  const code = crypto.randomUUID()
  const issuedAt = DateTime.unsafeNow()
  const codeExpiresAt = DateTime.addDuration(issuedAt, '60 seconds')

  store.commit(
    AuthorizationRequests.events.authorizationRequestApproved({
      id: requestId,
      grantedScopes,
      patient: patient ?? null,
    }),
    AuthorizationCodes.events.authorizationCodeIssued({
      code,
      requestId,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      grantedScopes,
      patient: patient ?? null,
      issuedAt,
      expiresAt: codeExpiresAt,
    })
  )

  const redirect = new URL(pending.redirectUri)
  redirect.searchParams.set('code', code)
  redirect.searchParams.set('state', pending.clientState)
  return redirect.toString()
}

function denyAuthorizationRequest(store: StoreHandle, requestId: string): void {
  const pending = store.query(AuthorizationRequests.queries.byId$(requestId))
  if (pending == null) return
  store.commit(AuthorizationRequests.events.authorizationRequestDenied({ id: requestId }))
}

/**
 * Validate a PIN attempt against the stored row. On success the challenge is
 * marked verified and a corresponding `sessions` row is created with the
 * given duration. The session id reuses the challenge id so the `/complete`
 * handler can find it. On failure the attempts counter is incremented; once
 * {@link MAX_PIN_ATTEMPTS} is reached the row is rejected and `false` is
 * returned.
 */
function verifyPinChallenge(
  store: StoreHandle,
  id: string,
  enteredPin: string,
  duration: SessionDuration
): boolean {
  const pending = store.query(PinChallenges.queries.byId$(id))
  if (pending == null) return false
  if (!timingSafeEqual(pending.pin, enteredPin)) {
    const attempts = pending.attempts + 1
    if (attempts >= MAX_PIN_ATTEMPTS) {
      store.commit(PinChallenges.events.pinChallengeRejected({ id }))
      return false
    }
    store.commit(PinChallenges.events.pinChallengeAttemptFailed({ id, attempts }))
    return false
  }

  const startedAt = DateTime.unsafeNow()
  const expiresAt = DateTime.addDuration(startedAt, `${sessionMaxAgeSeconds(duration)} seconds`)
  store.commit(
    PinChallenges.events.pinChallengeVerified({ id }),
    Sessions.events.sessionStarted({
      id: SessionIdSchema.make(id),
      startedAt,
      expiresAt,
      duration,
      label: 'PIN session',
    })
  )
  return true
}

function denyPinChallenge(store: StoreHandle, id: string): void {
  const pending = store.query(PinChallenges.queries.byId$(id))
  if (pending == null) return
  store.commit(PinChallenges.events.pinChallengeRejected({ id }))
}

export {
  approveAuthorizationRequest,
  denyAuthorizationRequest,
  verifyPinChallenge,
  denyPinChallenge,
  MAX_PIN_ATTEMPTS,
}
