import { Schema } from 'effect'
import { Bridge, UrlParamMessage } from 'effect-messaging-core'

/**
 * Host → Web: Expo host hands a bearer token to the embedded SPA so
 * HTTP calls to the gatekeeper API authenticate.
 */
const AuthTokenIssued = Schema.parseJson(
  Schema.TaggedStruct('AuthTokenIssued', { token: Schema.String })
)
type AuthTokenIssued = Schema.Schema.Type<typeof AuthTokenIssued>

/**
 * Host → Web: signals at boot that the host commits to delivering an
 * `AuthTokenIssued` later. Rides URL params (bare flag) so the web
 * `TransportProvider` dispatches it before the descendant tree mounts.
 * The web receiver flips `waitForHostTokenRef`; the auth gate consults
 * the flag and renders a neutral loader instead of falling through to
 * the device-flow UI while it waits.
 */
const WaitForToken = Schema.parseJson(Schema.TaggedStruct('WaitForToken', {}))
type WaitForToken = Schema.Schema.Type<typeof WaitForToken>

type GatekeeperBridge = Bridge.Bridge<
  'Gatekeeper',
  {
    AuthTokenIssued: typeof AuthTokenIssued
    WaitForToken: typeof WaitForToken
  },
  // No Web→Host messages today.
  // oxlint-disable-next-line typescript-eslint/no-empty-object-type
  {}
>

/**
 * Slice-level bridge for the gatekeeper auth surface. Web receives
 * `AuthTokenIssued` and `WaitForToken`; host sends them via URL-encoded
 * initial messages on the WebView's source URL.
 */
const GatekeeperBridge: GatekeeperBridge = Bridge.make({
  name: 'Gatekeeper',
  hostToWeb: [
    ['AuthTokenIssued', AuthTokenIssued],
    ['WaitForToken', WaitForToken],
  ] as const,
  webToHost: [] as const,
  urlParams: {
    AuthTokenIssued: UrlParamMessage.singleStringMessageSchema('AuthTokenIssued', 'token'),
    WaitForToken: UrlParamMessage.tagOnlyMessageSchema('WaitForToken'),
  },
})

export { GatekeeperBridge }
export default GatekeeperBridge
