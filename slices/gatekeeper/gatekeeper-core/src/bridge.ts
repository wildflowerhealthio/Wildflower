import { Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'

/**
 * Host → Web: the Expo host has just acquired a bearer token (e.g. via
 * the SMART-on-FHIR flow on the device) and is handing it to the
 * embedded SPA so HTTP calls to the gatekeeper API authenticate.
 *
 * Replaces the historical `window.__GATEKEEPER_TOKEN__` window-global
 * — the token now rides the unified bridge channel alongside
 * everything else flowing across the WebView boundary.
 */
const AuthTokenIssued = Schema.parseJson(
  Schema.TaggedStruct('AuthTokenIssued', { token: Schema.String })
)
type AuthTokenIssued = Schema.Schema.Type<typeof AuthTokenIssued>

const hostOptionsShape = Schema.Struct({
  initialToken: Schema.optional(Schema.String),
})
const webOptionsShape = Schema.Struct({})

type GatekeeperBridge = Bridge.Bridge<
  'Gatekeeper',
  {
    AuthTokenIssued: typeof AuthTokenIssued
  },
  // No Web→Host messages today — the embedded SPA neither requests
  // nor issues tokens back to the host. The empty record is permitted
  // and the aggregator that wires this bridge sees no web-to-host
  // traffic from gatekeeper alone.
  // oxlint-disable-next-line typescript-eslint/no-empty-object-type
  {},
  typeof hostOptionsShape,
  typeof webOptionsShape
>
/**
 * Slice-level bridge for the gatekeeper auth surface. Web side
 * receives `AuthTokenIssued`; Host side sends it (typically as part
 * of the WebView's initialMessages, with the token sourced from the
 * Expo app's auth flow).
 *
 * Options:
 *
 * - `hostOptionsShape` describes per-WebView config the Expo
 *   aggregator passes — currently `{ initialToken? }`, an optional
 *   pre-acquired token to seed via `__INITIAL_MESSAGES__`.
 * - `webOptionsShape` is empty.
 */
const GatekeeperBridge: GatekeeperBridge = Bridge.make({
  name: 'Gatekeeper',
  hostToWeb: [['AuthTokenIssued', AuthTokenIssued]] as const,
  webToHost: [] as const,
  hostOptionsShape,
  webOptionsShape,
})

export default GatekeeperBridge
