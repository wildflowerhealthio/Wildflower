import { Context, Layer } from 'effect'
import { timingSafeEqual } from '../internal/timing-safe-equal.ts'
import {
  getAuthStateSingleton,
  type PendingAuth,
  type PendingPinAuth,
  type PinAuthDuration,
} from './AuthState.ts'

type AuthRequestListener = (auth: PendingAuth) => void
type PinAuthListener = (auth: PendingPinAuth) => void

const authRequestListeners = new Set<AuthRequestListener>()
const pinAuthListeners = new Set<PinAuthListener>()

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

function notifyAuthRequestListeners(auth: PendingAuth): void {
  for (const listener of authRequestListeners) {
    listener(auth)
  }
}

function notifyPinAuthListeners(auth: PendingPinAuth): void {
  for (const listener of pinAuthListeners) {
    listener(auth)
  }
}

function approveAuthRequest(
  code: string,
  approvedScopes: string[],
  patient?: string
): string | null {
  const state = getAuthStateSingleton()
  const pending = state.pendingAuths.get(code)
  if (pending == null) return null

  pending.status = 'approved'
  pending.approvedScopes = approvedScopes
  pending.patient = patient

  const authEntry = state.authMaps.get(code)
  if (authEntry != null) {
    authEntry.approvedScopes = approvedScopes
    authEntry.scope = approvedScopes.join(' ')
    authEntry.patient = patient
  }

  const redirect = new URL(pending.redirect_uri)
  redirect.searchParams.set('code', code)
  redirect.searchParams.set('state', pending.state)
  return redirect.toString()
}

function declineAuthRequest(code: string): void {
  const state = getAuthStateSingleton()
  const pending = state.pendingAuths.get(code)
  if (pending == null) return
  pending.status = 'declined'
  state.pendingAuths.delete(code)
  state.authMaps.delete(code)
}

function approvePinAuth(id: string, enteredPin: string, duration: PinAuthDuration): boolean {
  const state = getAuthStateSingleton()
  const pending = state.pinAuths.get(id)
  if (pending == null) return false
  if (!timingSafeEqual(pending.pin, enteredPin)) return false
  pending.status = 'approved'
  pending.duration = duration
  return true
}

function declinePinAuth(id: string): void {
  const state = getAuthStateSingleton()
  const pending = state.pinAuths.get(id)
  if (pending == null) return
  pending.status = 'declined'
  state.pinAuths.delete(id)
}

interface AuthListenersShape {
  notifyAuthRequestListeners: (auth: PendingAuth) => void
  notifyPinAuthListeners: (auth: PendingPinAuth) => void
}

class AuthListeners extends Context.Tag('AuthListeners')<AuthListeners, AuthListenersShape>() {}

const AuthListenersLive = Layer.succeed(AuthListeners, {
  notifyAuthRequestListeners,
  notifyPinAuthListeners,
})

export {
  AuthListeners,
  AuthListenersLive,
  addAuthRequestListener,
  approveAuthRequest,
  declineAuthRequest,
  addPinAuthListener,
  approvePinAuth,
  declinePinAuth,
}
