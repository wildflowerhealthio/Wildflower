import type { Store } from '@livestore/livestore'
import { timingSafeEqual } from '../internal/timing-safe-equal.ts'
import {
  AuthCodes,
  PinAuths,
  type AuthCodeRow,
  type PinAuthDuration,
  type PinAuthRow,
  type schema,
} from '../livestore/index.ts'

type StoreHandle = Store<typeof schema, object>

type AuthRequestListener = (auth: AuthCodeRow) => void
type PinAuthListener = (auth: PinAuthRow) => void

const authRequestListeners = new Set<AuthRequestListener>()
const pinAuthListeners = new Set<PinAuthListener>()

const MAX_PIN_ATTEMPTS = 5

function addAuthRequestListener(listener: AuthRequestListener): () => void {
  authRequestListeners.add(listener)
  return () => {
    authRequestListeners.delete(listener)
  }
}

function addPinAuthListener(listener: PinAuthListener): () => void {
  pinAuthListeners.add(listener)
  return () => {
    pinAuthListeners.delete(listener)
  }
}

function notifyAuthRequestListeners(auth: AuthCodeRow): void {
  for (const listener of authRequestListeners) {
    listener(auth)
  }
}

function notifyPinAuthListeners(auth: PinAuthRow): void {
  for (const listener of pinAuthListeners) {
    listener(auth)
  }
}

/**
 * Mark an auth code as approved and return the redirect URL the OAuth client
 * should be sent to. Returns `null` when the code is not found.
 */
function approveAuthRequest(
  store: StoreHandle,
  code: string,
  approvedScopes: readonly string[],
  patient?: string
): string | null {
  const pending = store.query(AuthCodes.queries.byCode$(code))
  if (pending == null) return null

  store.commit(
    AuthCodes.events.authCodeApproved({
      code,
      approvedScopes,
      patient: patient ?? null,
    })
  )

  const redirect = new URL(pending.redirectUri)
  redirect.searchParams.set('code', code)
  redirect.searchParams.set('state', pending.state)
  return redirect.toString()
}

function declineAuthRequest(store: StoreHandle, code: string): void {
  const pending = store.query(AuthCodes.queries.byCode$(code))
  if (pending == null) return
  store.commit(AuthCodes.events.authCodeDeleted({ code }))
}

/**
 * Validate a PIN attempt against the stored row. On success the row is
 * marked approved with the given duration. On failure the attempts counter
 * is incremented; once {@link MAX_PIN_ATTEMPTS} is reached the row is
 * deleted and `false` is returned.
 */
function approvePinAuth(
  store: StoreHandle,
  id: string,
  enteredPin: string,
  duration: PinAuthDuration
): boolean {
  const pending = store.query(PinAuths.queries.byId$(id))
  if (pending == null) return false
  if (!timingSafeEqual(pending.pin, enteredPin)) {
    const attempts = pending.attempts + 1
    if (attempts >= MAX_PIN_ATTEMPTS) {
      store.commit(PinAuths.events.pinAuthDeleted({ id }))
      return false
    }
    store.commit(PinAuths.events.pinAuthAttemptFailed({ id, attempts }))
    return false
  }
  store.commit(PinAuths.events.pinAuthApproved({ id, duration }))
  return true
}

function declinePinAuth(store: StoreHandle, id: string): void {
  const pending = store.query(PinAuths.queries.byId$(id))
  if (pending == null) return
  store.commit(PinAuths.events.pinAuthDeleted({ id }))
}

export {
  addAuthRequestListener,
  approveAuthRequest,
  declineAuthRequest,
  addPinAuthListener,
  approvePinAuth,
  declinePinAuth,
  notifyAuthRequestListeners,
  notifyPinAuthListeners,
  MAX_PIN_ATTEMPTS,
}
