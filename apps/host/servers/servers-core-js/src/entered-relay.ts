import { Schema } from 'effect'

/**
 * What tells one relay from another, as a rathole client sees it: the
 * `host:port` it dials and the relay's X25519 noise public key, base64.
 */
const RelayIdentitySchema = Schema.Struct({
  remoteAddr: Schema.String,
  publicKey: Schema.String,
})

/** A decoded {@link RelayIdentitySchema}. */
type RelayIdentity = typeof RelayIdentitySchema.Type

/**
 * The relay as the user entered it, `server_add`'s `relay`: the Wildflower
 * relay; a self-hosted Wildflower relay by the base URL of its relay site,
 * with the identity its `GET /rathole` must serve, if pinned; or a rathole
 * relay with no relay site, by its identity and the relay domain a server's
 * domain ends in.
 *
 * @remarks
 * The host checks each setting, and refuses a bad one as
 * `invalidRelaySetting`, or a relay that doesn't serve its pin as
 * `pinMismatch`. A pin is checked and not stored. A rathole relay is not
 * asked anything: the tunnel coming up is its check.
 */
const EnteredRelaySchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('wildflowerOfficial') }),
  Schema.Struct({
    kind: Schema.Literal('selfHostedWildflower'),
    baseUrl: Schema.String,
    pin: Schema.optionalWith(RelayIdentitySchema, { exact: true }),
  }),
  Schema.Struct({
    kind: Schema.Literal('rathole'),
    ...RelayIdentitySchema.fields,
    domain: Schema.String,
  })
)

/** A decoded {@link EnteredRelaySchema}. */
type Type = typeof EnteredRelaySchema.Type

export { EnteredRelaySchema as Schema, RelayIdentitySchema }
export type { RelayIdentity, Type }
