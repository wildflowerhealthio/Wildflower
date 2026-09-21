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
 * The head of the pending-consent queue: which request the popup is
 * asking the Owner to decide, discriminated because the two OAuth flows
 * share no lookup key. See `slices/gatekeeper/docs/Jargon Explanation.md`
 * ("Pending-consent queue").
 */
const PendingConsentHead = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('device'), userCode: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('oauth'), id: Schema.String })
)
type PendingConsentHead = Schema.Schema.Type<typeof PendingConsentHead>

/**
 * Host → Web: the host informs the embedded SPA which (if any) pending
 * authorization request is currently first in line for owner consent.
 * The SPA surfaces a modal whenever `head` is non-null and hides it on
 * `null`. Only the head's lookup key rides the bridge — the popup uses
 * the existing `useDeviceConsentQuery(userCode)` /
 * `useOAuthConsentQuery(id)` HTTP fetches (the same ones the standalone
 * `/gatekeeper/devices/:userCode` and `/gatekeeper/oauth-polling/:id`
 * routes use) to hydrate the matching form, so there's one source of
 * truth per consent payload.
 *
 * Push-only: deliberately absent from `urlParams`. The standalone web
 * entries serve a stub transport and never see this message; the
 * Tauri host is the only emitter.
 *
 * @remarks
 * Wire: `{"_tag":"PendingConsentRequested","head":null}`,
 * `{"_tag":"PendingConsentRequested","head":{"kind":"device","userCode":"ABC-123"}}`,
 * or `{"_tag":"PendingConsentRequested","head":{"kind":"oauth","id":"…"}}`.
 */
const PendingConsentRequested = Schema.parseJson(
  Schema.TaggedStruct('PendingConsentRequested', {
    head: Schema.NullOr(PendingConsentHead),
  })
)
type PendingConsentRequested = Schema.Schema.Type<typeof PendingConsentRequested>

type GatekeeperBridge = Bridge.Bridge<
  'Gatekeeper',
  {
    AuthTokenIssued: typeof AuthTokenIssued
    PendingConsentRequested: typeof PendingConsentRequested
  },
  // No Web→Host messages today.
  // oxlint-disable-next-line typescript-eslint/no-empty-object-type
  {}
>

/**
 * Slice-level bridge for the gatekeeper auth surface. Web receives
 * `AuthTokenIssued` (a contentless notify — pull the bearer
 * out-of-band, the multiplexed channel never carries the secret) and
 * `PendingConsentRequested` (the pending-consent head). Both
 * messages are Tauri-emitted; no URL-param fallback (the bearer must
 * never be embeddable in a URL that could leak through history or
 * Referer headers).
 */
const GatekeeperBridge: GatekeeperBridge = Bridge.make({
  name: 'Gatekeeper',
  hostToWeb: [
    ['AuthTokenIssued', AuthTokenIssued],
    ['PendingConsentRequested', PendingConsentRequested],
  ] as const,
  webToHost: [] as const,
})

export { GatekeeperBridge, PendingConsentHead }
export default GatekeeperBridge
