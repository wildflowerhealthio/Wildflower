import { Schema } from 'effect'
import { defineBridge } from 'interop-core'

/**
 * Native → Web: the Expo host has just acquired a bearer token (e.g. via
 * the SMART-on-FHIR flow on the device) and is handing it to the
 * embedded SPA so HTTP calls to the gatekeeper API authenticate.
 *
 * Replaces the historical `window.__GATEKEEPER_TOKEN__` window-global —
 * the token now rides the unified bridge channel alongside everything
 * else flowing across the WebView boundary.
 */
const AuthTokenIssued = Schema.parseJson(
  Schema.TaggedStruct('AuthTokenIssued', { token: Schema.String })
)
type AuthTokenIssued = Schema.Schema.Type<typeof AuthTokenIssued>

/**
 * Slice-level bridge for the gatekeeper auth surface. Web side receives
 * `AuthTokenIssued`; Native side sends it (typically as part of the
 * WebView's initialMessages, with the token sourced from the Expo
 * app's auth flow).
 *
 * No Web→Native messages today — the embedded SPA neither requests nor
 * issues tokens back to the host. The empty `webToNative` record is
 * permitted; aggregators that wire this bridge won't see any web-to-
 * native traffic from gatekeeper alone.
 *
 * Options:
 *
 * - `nativeOptionsShape` describes per-WebView config the Expo
 *   aggregator passes — currently `{ initialToken? }`, an optional
 *   pre-acquired token to seed via `__INITIAL_MESSAGES__`.
 * - `webOptionsShape` is empty.
 */
const GatekeeperBridge = defineBridge({
  name: 'Gatekeeper',
  nativeToWeb: [['AuthTokenIssued', AuthTokenIssued]] as const,
  webToNative: [] as const,
  nativeOptionsShape: Schema.Struct({
    initialToken: Schema.optional(Schema.String),
  }),
  webOptionsShape: Schema.Struct({}),
})

export { AuthTokenIssued, GatekeeperBridge }
export type { AuthTokenIssued as AuthTokenIssuedType }
