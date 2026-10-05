import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { DateTime, Schema } from 'effect'

/**
 * A unix time in whole seconds on the wire, a `DateTime.Utc` in code. The
 * relay's `created_at` is `i64` epoch seconds.
 */
const UnixSecondsUtc = Schema.transform(Schema.Int, Schema.DateTimeUtcFromSelf, {
  strict: true,
  decode: (seconds) => DateTime.unsafeMake(seconds * 1000),
  encode: (utc) => Math.floor(DateTime.toEpochMillis(utc) / 1000),
})

/**
 * A tunnel as `GET /api/tunnels` lists it — mirrors the Rust `TunnelInfo` in
 * `apps/relay/server/src/site/admin.rs`. No token: the relay shows a token only
 * once, when the tunnel is created.
 */
const TunnelInfoSchema = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  /** `<tunnel name>.<domain>`. */
  public_host: Schema.String,
  created_at: UnixSecondsUtc,
})

/**
 * `POST /api/tunnels` body — mirrors the Rust `CreateTunnel`. Without `name`
 * the relay picks one (two words joined by a hyphen).
 */
const CreateTunnelBodySchema = Schema.Struct({
  email: Schema.String,
  name: Schema.optional(Schema.String),
})

/**
 * A tunnel just created — mirrors the Rust `CreatedTunnel`. The only response
 * that carries the token; nothing can read it back later.
 */
const CreatedTunnelSchema = Schema.Struct({
  name: Schema.String,
  token: Schema.String,
  /** `<tunnel name>.<domain>`. */
  public_host: Schema.String,
})

/**
 * A refused change, with the relay's short plain-text reason (e.g. `a tunnel
 * already has the name`).
 */
const plainTextReason = <Self extends { readonly reason: string }, Tag extends string>(
  errorClass: Schema.Schema<Self, { readonly _tag: Tag; readonly reason: string }>,
  tag: Tag,
  status: number
): Schema.Schema<Self, string> =>
  Schema.transform(Schema.String, errorClass, {
    strict: true,
    decode: (reason) => ({ _tag: tag, reason }),
    encode: (error) => error.reason,
  }).pipe(
    HttpApiSchema.withEncoding({ kind: 'Text', contentType: 'text/plain; charset=utf-8' }),
    (schema) => schema.annotations(HttpApiSchema.annotations({ status }))
  )

/** `404`: no tunnel has the name being deleted. */
class TunnelNotFound extends Schema.TaggedError<TunnelNotFound>()('TunnelNotFound', {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

/** `409`: the name is reserved, or a tunnel already has it. */
class TunnelNameConflict extends Schema.TaggedError<TunnelNameConflict>()('TunnelNameConflict', {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

/** `422`: the name is not a lowercase DNS label, or the email is unusable. */
class TunnelRejected extends Schema.TaggedError<TunnelRejected>()('TunnelRejected', {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

/** `503`: the relay has no name left to pick. */
class TunnelNamesExhausted extends Schema.TaggedError<TunnelNamesExhausted>()(
  'TunnelNamesExhausted',
  { reason: Schema.String }
) {
  override get message(): string {
    return this.reason
  }
}

const TunnelNotFoundFromText = plainTextReason(TunnelNotFound, 'TunnelNotFound', 404)
const TunnelNameConflictFromText = plainTextReason(TunnelNameConflict, 'TunnelNameConflict', 409)
const TunnelRejectedFromText = plainTextReason(TunnelRejected, 'TunnelRejected', 422)
const TunnelNamesExhaustedFromText = plainTextReason(
  TunnelNamesExhausted,
  'TunnelNamesExhausted',
  503
)

/**
 * The relay's admin API on `admin.<domain>` — mirrors
 * `apps/relay/server/src/site/admin.rs`. Every request must be signed with
 * `keyid="admin"` (see `relay-core/signing`); the relay answers anything else,
 * and a signature it cannot verify (a wrong key, or `created` too far from its
 * clock), with an empty `401`.
 *
 * - `CreateTunnel`: `201` with the token, shown only here; `409` for a name
 *   that is reserved or taken, `422` for a bad name or email, `503` when no
 *   name is left.
 * - `ListTunnels`: every tunnel, no tokens.
 * - `DeleteTunnel`: `204`; `404` when no tunnel has the name.
 */
const httpApiGroup = HttpApiGroup.make('tunnels', { topLevel: false })
  .add(
    HttpApiEndpoint.post('CreateTunnel', '/api/tunnels')
      .setPayload(CreateTunnelBodySchema)
      .addSuccess(CreatedTunnelSchema, { status: 201 })
      .addError(TunnelNameConflictFromText)
      .addError(TunnelRejectedFromText)
      .addError(TunnelNamesExhaustedFromText)
  )
  .add(
    HttpApiEndpoint.get('ListTunnels', '/api/tunnels').addSuccess(Schema.Array(TunnelInfoSchema))
  )
  .add(
    HttpApiEndpoint.del('DeleteTunnel', '/api/tunnels/:name')
      .setPath(Schema.Struct({ name: Schema.String }))
      .addSuccess(HttpApiSchema.NoContent)
      .addError(TunnelNotFoundFromText)
  )
  .addError(HttpApiError.Unauthorized)

export {
  CreatedTunnelSchema,
  CreateTunnelBodySchema,
  httpApiGroup,
  TunnelInfoSchema,
  TunnelNameConflict,
  TunnelNamesExhausted,
  TunnelNotFound,
  TunnelRejected,
  UnixSecondsUtc,
}
