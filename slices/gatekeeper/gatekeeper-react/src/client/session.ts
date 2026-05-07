/**
 * `Session` factories. A session bundles a `ManagedRuntime` whose
 * context provides both `HttpClient.HttpClient` (for sibling-API
 * client construction, e.g. fhir-r4) and the `GatekeeperClient`
 * service tag — call sites compose Effects that depend on either
 * service and run them through `runPromise`.
 *
 * The authenticated/unauthenticated split mirrors the two states the
 * gatekeeper client can be in: with or without a bearer token in
 * localStorage. The split exists so screens that need an
 * authenticated session aren't structurally able to call the
 * unauthenticated factory.
 */

import type { Effect } from 'effect'
import { ManagedRuntime } from 'effect'

import { buildSessionLayer, type SessionEnv, type SessionRuntime } from './session-layer.ts'

/**
 * Unauthenticated counterpart to `AuthenticatedSession`. Used by the
 * device-authorization sign-in flow, which has to talk to
 * `/oauth/device_authorization` and `/oauth/token` *before* a bearer
 * token exists. The provided `GatekeeperClient` is built without a
 * bearer header.
 */
interface UnauthenticatedSession {
  /**
   * The shared `ManagedRuntime` so callers can build clients for
   * sibling APIs with the same `FetchHttpClient` + telemetry layers
   * (e.g. `HttpApiClient.make(FhirResourcesApi, …)`).
   */
  readonly runtime: SessionRuntime
  /**
   * Run an effect against the session runtime. The effect's context
   * may include `GatekeeperClient` (typed gatekeeper API),
   * `HttpClient.HttpClient` (raw HTTP), or any subset.
   */
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
  /**
   * The bearer token associated with this session. Exposed so the
   * runtime can be reused to talk to sibling APIs (e.g. fhir-r4)
   * without round-tripping through localStorage.
   */
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
