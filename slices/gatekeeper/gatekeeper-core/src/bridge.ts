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
 * Host → Web: the `userCode` of the device-authorization request the SPA
 * should currently prompt the practitioner to approve, or `null` to
 * dismiss the prompt. The host derives this as the FIFO head of its
 * pending device-code requests; the SPA pops a consent modal over
 * whatever page is showing.
 *
 * Push-only — deliberately absent from {@link GatekeeperBridge}'s
 * `urlParams`. A cold-start URL param can only ever be stale (a request
 * may resolve or expire before the WebView loads), and the host re-pushes
 * the live head on every page `__Ready` anyway.
 */
const DeviceAuthorizationActiveChanged = Schema.parseJson(
  Schema.TaggedStruct('DeviceAuthorizationActiveChanged', {
    userCode: Schema.NullOr(Schema.String),
  })
)
type DeviceAuthorizationActiveChanged = Schema.Schema.Type<typeof DeviceAuthorizationActiveChanged>

type GatekeeperBridge = Bridge.Bridge<
  'Gatekeeper',
  {
    AuthTokenIssued: typeof AuthTokenIssued
    DeviceAuthorizationActiveChanged: typeof DeviceAuthorizationActiveChanged
  },
  // No Web→Host messages today.
  // oxlint-disable-next-line typescript-eslint/no-empty-object-type
  {}
>

/**
 * Slice-level bridge for the gatekeeper auth surface. Web receives
 * `AuthTokenIssued` (the bearer, delivered via URL-encoded initial
 * messages on the WebView's source URL so it never touches a postMessage
 * channel before the transport's `peerReadyGate` has lifted) and
 * `DeviceAuthorizationActiveChanged` (the live device-consent head,
 * push-only).
 */
const GatekeeperBridge: GatekeeperBridge = Bridge.make({
  name: 'Gatekeeper',
  hostToWeb: [
    ['AuthTokenIssued', AuthTokenIssued],
    ['DeviceAuthorizationActiveChanged', DeviceAuthorizationActiveChanged],
  ] as const,
  webToHost: [] as const,
  urlParams: {
    AuthTokenIssued: UrlParamMessage.singleStringMessageSchema('AuthTokenIssued', 'token'),
    // DeviceAuthorizationActiveChanged deliberately omitted — see its
    // docstring: push-only, never seeded through the WebView URL.
  },
})

export { GatekeeperBridge }
export default GatekeeperBridge
