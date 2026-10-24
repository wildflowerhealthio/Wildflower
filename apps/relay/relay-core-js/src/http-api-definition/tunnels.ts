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
 * What became of a connection routed to a tunnel — mirrors the Rust
 * `TunnelOutcome` in `apps/relay/relay-server/src/domain/connection_outcome.rs`:
 *
 * - `ok`: it reached the device.
 * - `tunnel_down`: the device is not connected.
 * - `tunnel_busy`: the device is connected but not taking connections.
 * - `tunnel_closed`: the tunnel closed it before it reached the device.
 * - `proxy_header_failed`: the relay failed to send it on.
 */
const TunnelOutcome = Schema.Literal(
  'ok',
  'tunnel_down',
  'tunnel_busy',
  'tunnel_closed',
  'proxy_header_failed'
)

/**
 * A tunnel as `GET /api/tunnels` lists it — mirrors the Rust `TunnelInfo` in
 * `apps/relay/relay-server/src/site/admin.rs`. No token: the relay shows a
 * token only once, when the tunnel is created or its token reissued.
 */
const TunnelInfoSchema = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  /** `<tunnel name>.<domain>`. */
  public_host: Schema.String,
  created_at: UnixSecondsUtc,
  /**
   * What became of the last connection to the tunnel since the relay
   * started, `null` before the first.
   */
  last_outcome: Schema.NullOr(TunnelOutcome),
})

/**
 * One UTC hour as `GET /api/connection-totals` lists it — mirrors the Rust
 * `ConnectionTotalsBody` in `apps/relay/relay-server/src/site/admin.rs`: how
 * many connections had each outcome, zeros included. `ok` reached a device;
 * every other field is a reason a connection was refused. No identifiers.
 */
const ConnectionTotalsSchema = Schema.Struct({
  /** The hour's start. */
  hour: UnixSecondsUtc,
  ok: Schema.Int,
  /** The relay was at its connection limit. */
  over_connection_limit: Schema.Int,
  /** No TLS ClientHello arrived in time. */
  hello_timeout: Schema.Int,
  /** The first bytes were not a TLS ClientHello. */
  not_a_hello: Schema.Int,
  /** The ClientHello named no host. */
  no_server_name: Schema.Int,
  /** The host named no tunnel. */
  unknown_tunnel: Schema.Int,
  tunnel_down: Schema.Int,
  tunnel_busy: Schema.Int,
  tunnel_closed: Schema.Int,
  proxy_header_failed: Schema.Int,
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
 * A tunnel with its token, just created or reissued — mirrors the Rust
 * `TunnelWithToken`. The only responses that carry a token; nothing can read
 * it back later.
 */
const TunnelWithTokenSchema = Schema.Struct({
  name: Schema.String,
  token: Schema.String,
  /** `<tunnel name>.<domain>`. */
  public_host: Schema.String,
})

/**
 * A claim code just issued — mirrors the Rust `IssuedClaimCodeBody`. The
 * only response that carries the code, shown as `ABCD-EFGH`, and when it
 * expires. It redeems once, at the relay's `POST /claim`, until
 * `expires_at`: a tunnel's code for its name and token, until the tunnel's
 * next code replaces it; a code that names no tunnel for a new one, under
 * the email and name the redeemer chooses.
 */
const IssuedClaimCodeSchema = Schema.Struct({
  code: Schema.String,
  expires_at: UnixSecondsUtc,
})

/**
 * A refused change, with the relay's short plain-text reason (e.g.
 * `a tunnel already has the name`).
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

/**
 * `404`: no tunnel has the name being deleted, issued a claim code or
 * reissued a token.
 */
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
 * `apps/relay/relay-server/src/site/admin.rs`. Every request must be signed with
 * `keyid="admin"` (see `relay-core-js/signing`); the relay answers anything else,
 * and a signature it cannot verify (a wrong key, or `created` too far from its
 * clock), with an empty `401`.
 *
 * - `CreateTunnel`: `201` with the token, shown only here; `409` for a name
 *   that is reserved or taken, `422` for a bad name or email, `503` when no
 *   name is left.
 * - `ListTunnels`: every tunnel, no tokens, with its last connection's
 *   outcome since the relay started.
 * - `DeleteTunnel`: `204`; `404` when no tunnel has the name.
 * - `IssueClaimCode`: `201` with a claim code for the tunnel, shown only
 *   here, and when it expires, replacing the tunnel's earlier code; `404`
 *   when no tunnel has the name.
 * - `IssueOpenClaimCode`: `201` with a claim code that names no tunnel,
 *   shown only here, and when it expires: whoever redeems it creates one.
 * - `ReissueToken`: `200` with a new token for the tunnel, shown only here.
 *   The old token stops working at once, and the device connected with it
 *   drops until it is given the new one. `404` when no tunnel has the name.
 * - `ListConnectionTotals`: one row per UTC hour of the last 30 days with any
 *   connection, oldest first.
 */
const httpApiGroup = HttpApiGroup.make('tunnels', { topLevel: false })
  .add(
    HttpApiEndpoint.post('CreateTunnel', '/api/tunnels')
      .setPayload(CreateTunnelBodySchema)
      .addSuccess(TunnelWithTokenSchema, { status: 201 })
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
  .add(
    HttpApiEndpoint.post('IssueClaimCode', '/api/tunnels/:name/claim-codes')
      .setPath(Schema.Struct({ name: Schema.String }))
      .addSuccess(IssuedClaimCodeSchema, { status: 201 })
      .addError(TunnelNotFoundFromText)
  )
  .add(
    HttpApiEndpoint.post('IssueOpenClaimCode', '/api/claim-codes').addSuccess(
      IssuedClaimCodeSchema,
      { status: 201 }
    )
  )
  .add(
    HttpApiEndpoint.post('ReissueToken', '/api/tunnels/:name/token')
      .setPath(Schema.Struct({ name: Schema.String }))
      .addSuccess(TunnelWithTokenSchema)
      .addError(TunnelNotFoundFromText)
  )
  .add(
    HttpApiEndpoint.get('ListConnectionTotals', '/api/connection-totals').addSuccess(
      Schema.Array(ConnectionTotalsSchema)
    )
  )
  .addError(HttpApiError.Unauthorized)

export {
  ConnectionTotalsSchema,
  CreateTunnelBodySchema,
  httpApiGroup,
  IssuedClaimCodeSchema,
  TunnelInfoSchema,
  TunnelNameConflict,
  TunnelNamesExhausted,
  TunnelNotFound,
  TunnelOutcome,
  TunnelRejected,
  TunnelWithTokenSchema,
  UnixSecondsUtc,
}
