import { Schema } from 'effect'

/**
 * The credentials the user entered to add a server with, `server_add`'s
 * `credentials`: a claim code from the relay's admin, such as `ABCD-EFGH`,
 * which a Wildflower relay redeems once for the tunnel's name and token; or
 * the tunnel's name and token themselves.
 *
 * @remarks
 * The host takes each value as typed and checks it: it trims a code or a
 * token, and refuses a blank one as `emptyClaimCode` or `emptyToken`, and a
 * tunnel name that isn't one lowercase DNS label as `invalidTunnelName`. A
 * rathole relay redeems no claim codes, so the host refuses one entered for
 * it as `claimCodesNotOffered`. The code is spent at the relay and kept
 * nowhere.
 */
const EnteredCredentialsSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('claimCode'), code: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('token'),
    tunnelName: Schema.String,
    token: Schema.String,
  })
)

/** A decoded {@link EnteredCredentialsSchema}. */
type Type = typeof EnteredCredentialsSchema.Type

export { EnteredCredentialsSchema as Schema }
export type { Type }
