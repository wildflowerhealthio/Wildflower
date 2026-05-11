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

type GatekeeperBridge = Bridge.Bridge<
  'Gatekeeper',
  {
    AuthTokenIssued: typeof AuthTokenIssued
  },
  // No Web→Host messages today.
  // oxlint-disable-next-line typescript-eslint/no-empty-object-type
  {}
>

/**
 * Slice-level bridge for the gatekeeper auth surface. Web receives
 * `AuthTokenIssued`; host sends it, typically via URL-encoded initial
 * messages on the WebView's source URL.
 */
const GatekeeperBridge: GatekeeperBridge = Bridge.make({
  name: 'Gatekeeper',
  hostToWeb: [['AuthTokenIssued', AuthTokenIssued]] as const,
  webToHost: [] as const,
  urlParams: {
    AuthTokenIssued: UrlParamMessage.singleStringMessageSchema('AuthTokenIssued', 'token'),
  },
})

export default GatekeeperBridge
