import type { Effect } from 'effect'
import { ManagedRuntime } from 'effect'

import { buildSessionLayer, type SessionEnv, type SessionRuntime } from './session-layer.ts'

/**
 * Session for pre-auth flows (device-authorization sign-in). The provided
 * `GatekeeperClient` is built without a bearer header.
 */
interface UnauthenticatedSession {
  readonly runtime: SessionRuntime
  readonly runPromise: <A, E>(eff: Effect.Effect<A, E, SessionEnv>) => Promise<A>
}

const makeUnauthenticatedSession = (): UnauthenticatedSession => {
  const runtime: SessionRuntime = ManagedRuntime.make(buildSessionLayer(null))
  return {
    runtime,
    runPromise: (eff) => runtime.runPromise(eff),
  }
}

interface AuthenticatedSession extends UnauthenticatedSession {
  /** Bearer token; exposed so callers can build sibling-API clients with the same auth. */
  readonly token: string
}

const makeAuthenticatedSession = (token: string): AuthenticatedSession => {
  const runtime: SessionRuntime = ManagedRuntime.make(buildSessionLayer(token))
  return {
    token,
    runtime,
    runPromise: (eff) => runtime.runPromise(eff),
  }
}

export {
  makeAuthenticatedSession,
  makeUnauthenticatedSession,
  type AuthenticatedSession,
  type UnauthenticatedSession,
}
