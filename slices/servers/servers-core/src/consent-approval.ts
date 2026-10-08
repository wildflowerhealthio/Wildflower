import { Option, Schema } from 'effect'

import type * as ConsentDetails from './consent-details.ts'

/**
 * The Owner's approval of a waiting consent, `kind`-tagged as its
 * `ConsentKey` is: the scopes left ticked and, for an app, the patient chosen
 * and whether the Owner acknowledged a `new` or `changed` registration.
 *
 * @remarks
 * The host refuses an unacknowledged approval of a `new` or `changed` app as
 * `registrationNotAcknowledged`.
 */
const ConsentApprovalSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('device'),
    userCode: Schema.String,
    approvedScopes: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('oauth'),
    id: Schema.String,
    approvedScopes: Schema.Array(Schema.String),
    patient: Schema.optionalWith(Schema.String, { exact: true }),
    acknowledgedRegistration: Schema.Boolean,
  })
)

/** A decoded {@link ConsentApprovalSchema}. */
type Type = typeof ConsentApprovalSchema.Type

/** The approval of the device pairing `details`, granting `approvedScopes`. */
const ofDevice = (details: ConsentDetails.Device, approvedScopes: readonly string[]): Type => ({
  kind: 'device',
  userCode: details.userCode,
  approvedScopes,
})

/**
 * The approval of the app request `details`, granting `approvedScopes` for
 * `patient`, if any. `acknowledged` is whether the Owner ticked the
 * acknowledgement, which counts only for a `new` or `changed` registration.
 */
const ofOAuth = (
  details: ConsentDetails.OAuth,
  {
    approvedScopes,
    patient,
    acknowledged,
  }: {
    readonly approvedScopes: readonly string[]
    readonly patient: Option.Option<string>
    readonly acknowledged: boolean
  }
): Type => ({
  kind: 'oauth',
  id: details.id,
  approvedScopes,
  ...patient.pipe(
    Option.map((id) => ({ patient: id })),
    Option.getOrElse(() => ({}))
  ),
  acknowledgedRegistration: details.registration.status !== 'registered' && acknowledged,
})

export { ConsentApprovalSchema as Schema, ofDevice, ofOAuth }
export type { Type }
