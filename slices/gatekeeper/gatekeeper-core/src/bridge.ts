import { Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'

/**
 * Host → Web: notify-only signal that a fresh bearer is available
 * for the SPA to pull. The token does NOT ride this message — it is
 * fetched out-of-band via a capability-gated Tauri command (so it
 * never travels on the multiplexed bridge channel that sibling
 * webviews can subscribe to). Sent on first page load and on every
 * mid-session re-mint.
 *
 * @remarks
 * Wire shape is the bare envelope `{"_tag":"AuthTokenIssued"}`.
 */
const AuthTokenIssued = Schema.parseJson(Schema.TaggedStruct('AuthTokenIssued', {}))
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
 * `AuthTokenIssued` (a contentless notify — pull the bearer
 * out-of-band, the multiplexed channel never carries the secret) and
 * `DeviceConsentRequested` (the pending device-consent head). Both
 * messages are Tauri-emitted; no URL-param fallback (the bearer must
 * never be embeddable in a URL that could leak through history or
 * Referer headers).
 */
const GatekeeperBridge: GatekeeperBridge = Bridge.make({
  name: 'Gatekeeper',
  hostToWeb: [
    ['AuthTokenIssued', AuthTokenIssued],
    ['DeviceConsentRequested', DeviceConsentRequested],
  ] as const,
  webToHost: [] as const,
})

export { GatekeeperBridge }
export default GatekeeperBridge
