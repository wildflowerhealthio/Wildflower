import { Schema } from 'effect'

/**
 * The credentials the user entered to add a server with, `server_add`'s
 * `credentials`: a claim code from the relay's admin, such as `ABCD-EFGH`,
 * which a Wildflower relay redeems once for the tunnel's name and token; an
 * access code from the relay's admin, in the same format, which it redeems
 * once for a new tunnel for the email entered, under the tunnel name
 * entered or, without one, a name the relay picks; or the tunnel's name and
 * token themselves.
 *
 * @remarks
 * The host takes each value as typed and checks it: it trims a code, an
 * email or a token, and refuses a blank one as `emptyClaimCode`,
 * `emptyEmail` or `emptyToken`, and a tunnel name that isn't one lowercase
 * DNS label as `invalidTunnelName`. A code entered as a claim code that the
 * relay holds as an access code is refused as `accessCodeNeedsDetails`,
 * unspent, so it can be entered again as an access code. A rathole relay
 * redeems no codes, so the host refuses one entered for it as
 * `claimCodesNotOffered`. A code is spent at the relay and kept nowhere.
 */
const EnteredCredentialsSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('claimCode'), code: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('accessCode'),
    code: Schema.String,
    email: Schema.String,
    tunnelName: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('token'),
    tunnelName: Schema.String,
    token: Schema.String,
  })
)

/** A decoded {@link EnteredCredentialsSchema}. */
type Type = typeof EnteredCredentialsSchema.Type

/**
 * A claim code or access code as a Wildflower relay reads one, mirroring the relay's
 * `ClaimCode::parse` (`relay-server`'s `domain/claim_code.rs`): after
 * trimming, eight characters of `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, in either
 * case, optionally split into two groups of four by a dash, `ABCD-EFGH`.
 */
const ClaimCodeSchema = Schema.String.pipe(
  Schema.pattern(/^\s*[2-9A-HJKMNP-Z]{4}-?[2-9A-HJKMNP-Z]{4}\s*$/i, {
    description: 'a claim code, such as ABCD-EFGH',
  })
)

/**
 * Whether `code`, as typed, is a claim code or access code a Wildflower
 * relay could redeem, by {@link ClaimCodeSchema}'s format; whether the relay knows it is
 * for the relay to say.
 */
const isClaimCode: (code: string) => boolean = Schema.is(ClaimCodeSchema)

export { ClaimCodeSchema, EnteredCredentialsSchema as Schema, isClaimCode }
export type { Type }
