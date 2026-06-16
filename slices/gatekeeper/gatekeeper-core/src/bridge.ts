import { Schema } from 'effect'
import { Bridge, UrlParamMessage } from 'effect-messaging-core'

/**
 * Host → Web: Tauri/Expo host hands a bearer token to the embedded SPA
 * so HTTP calls to the gatekeeper API authenticate.
 */
const AuthTokenIssued = Schema.parseJson(
  Schema.TaggedStruct('AuthTokenIssued', { token: Schema.String })
)
type AuthTokenIssued = Schema.Schema.Type<typeof AuthTokenIssued>

/**
 * Host → Web: the host informs the embedded SPA which (if any)
 * pending device-flow authorization request is currently first in line
 * for owner consent. The SPA surfaces a non-dismissable modal whenever
 * this is a string and hides it on `null`. Only the `userCode` rides
 * the bridge — the popup uses the existing
 * `useDeviceConsentQuery(userCode)` HTTP fetch (the same one the
 * standalone `/gatekeeper/devices/:userCode` route uses) to hydrate
 * the form, so there's one source of truth for the consent payload.
 *
 * Push-only: deliberately absent from `urlParams`. The standalone web
 * entries serve a stub transport and never see this message; the
 * Tauri host is the only emitter.
 */
const DeviceConsentRequested = Schema.parseJson(
  Schema.TaggedStruct('DeviceConsentRequested', {
    userCode: Schema.NullOr(Schema.String),
  })
)
type DeviceConsentRequested = Schema.Schema.Type<typeof DeviceConsentRequested>

type GatekeeperBridge = Bridge.Bridge<
  'Gatekeeper',
  {
    AuthTokenIssued: typeof AuthTokenIssued
    DeviceConsentRequested: typeof DeviceConsentRequested
  },
  // No Web→Host messages today.
  // oxlint-disable-next-line typescript-eslint/no-empty-object-type
  {}
>

/**
 * Slice-level bridge for the gatekeeper auth surface. Web receives
 * `AuthTokenIssued` (the bearer the host minted at boot) and
 * `DeviceConsentRequested` (the pending device-consent head). The
 * Tauri host emits both as per-tag events; the Expo host emits
 * `AuthTokenIssued` via URL-encoded initial messages on the WebView's
 * source URL (so the bearer never touches a postMessage channel
 * before the transport's `peerReadyGate` has lifted) and does not
 * emit consent — the device-consent popup is Tauri-only for now.
 */
const GatekeeperBridge: GatekeeperBridge = Bridge.make({
  name: 'Gatekeeper',
  hostToWeb: [
    ['AuthTokenIssued', AuthTokenIssued],
    ['DeviceConsentRequested', DeviceConsentRequested],
  ] as const,
  webToHost: [] as const,
  urlParams: {
    AuthTokenIssued: UrlParamMessage.singleStringMessageSchema('AuthTokenIssued', 'token'),
  },
})

export { GatekeeperBridge }
export default GatekeeperBridge
