import { Schema } from 'effect'

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

export { ConsentApprovalSchema as Schema }
export type { Type }
