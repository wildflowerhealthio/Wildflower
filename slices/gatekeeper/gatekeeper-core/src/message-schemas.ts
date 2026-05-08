import { Schema } from 'effect'
import { makeMessageRecord } from 'interop-core'

/**
 * Native → Web: the Expo host has just acquired a bearer token (e.g. via
 * the SMART-on-FHIR flow on the device) and is handing it to the
 * embedded SPA so HTTP calls to the gatekeeper API authenticate.
 *
 * Replaces the historical `window.__GATEKEEPER_TOKEN__` window-global —
 * the token now rides the unified message channel alongside everything
 * else flowing across the bridge.
 */
const AuthTokenIssued = Schema.parseJson(
  Schema.TaggedStruct('AuthTokenIssued', { token: Schema.String })
)
type AuthTokenIssued = Schema.Schema.Type<typeof AuthTokenIssued>

/** Slice-Native→Web messages contributed by gatekeeper. */
const GatekeeperNativeToWeb = makeMessageRecord([['AuthTokenIssued', AuthTokenIssued]] as const)
type GatekeeperNativeToWeb = typeof GatekeeperNativeToWeb

/** Slice-Web→Native messages contributed by gatekeeper. None yet — the empty record is permitted. */
const GatekeeperWebToNative = makeMessageRecord([] as const)
type GatekeeperWebToNative = typeof GatekeeperWebToNative

export { AuthTokenIssued, GatekeeperNativeToWeb, GatekeeperWebToNative }
export type { AuthTokenIssued as AuthTokenIssuedType }
