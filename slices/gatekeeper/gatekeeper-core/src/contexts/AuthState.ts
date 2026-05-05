import type { DateTime } from 'effect'
import { Context, Layer } from 'effect'

type PendingAuth = {
  code: string
  client_id: string
  scope: string
  redirect_uri: string
  code_challenge: string
  state: string
  status: 'pending' | 'approved' | 'declined'
  approvedScopes?: string[]
  patient?: string
  preApprovedScopes?: string[]
}

type AuthCode = {
  code: string
  code_challenge: string
  client_id: string
  scope: string
  redirect_uri: string
  exp: DateTime.Utc
  approvedScopes?: string[]
  patient?: string
}

type PinAuthDuration = 'request' | '1min' | '15min'

type PendingPinAuth = {
  id: string
  pin: string
  returnTo: string
  exp: DateTime.Utc
  status: 'pending' | 'approved' | 'declined'
  duration?: PinAuthDuration
  sessionToken?: string
}

interface AuthStateShape {
  authMaps: Map<string, AuthCode>
  pendingAuths: Map<string, PendingAuth>
  pinAuths: Map<string, PendingPinAuth>
}

const authStateSingleton: AuthStateShape = {
  authMaps: new Map<string, AuthCode>(),
  pendingAuths: new Map<string, PendingAuth>(),
  pinAuths: new Map<string, PendingPinAuth>(),
}

class AuthState extends Context.Tag('AuthState')<AuthState, AuthStateShape>() {}

const AuthStateLive = Layer.sync(AuthState, () => authStateSingleton)

const getAuthStateSingleton = (): AuthStateShape => authStateSingleton

export { AuthState, AuthStateLive, getAuthStateSingleton }
export type { PendingAuth, AuthCode, PendingPinAuth, PinAuthDuration, AuthStateShape }
