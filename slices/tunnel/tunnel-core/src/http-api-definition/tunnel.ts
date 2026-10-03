import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

/**
 * The readable view of the relay connection — the non-secret fields,
 * mirroring the Rust `RelayView`. The `token` is write-only and never
 * returned, so it's absent here. `null` on the wire means no relay is
 * configured.
 */
const RelayViewSchema = Schema.Struct({
  remoteAddr: Schema.String,
  publicKey: Schema.String,
  serviceName: Schema.String,
})

/**
 * Tunnel state on the wire — mirrors the Rust `TunnelStateResponse`
 * (`slices/tunnel/tunnel-rust/.../routes/tunnel/wire_representations.rs`,
 * `#[serde(rename_all = "camelCase")]`). The relay's non-secret fields are
 * returned in `relay` (the `token` stays write-only and never appears here).
 *
 * `settingsRevision` is the optimistic-concurrency token: a PUT must echo the
 * last-seen revision, and a stale one is rejected with `409` (see
 * {@link httpApiGroup}).
 *
 * `status` is the authoritative liveness FSM position — one of `off`,
 * `misconfigured`, `dialing`, `verified`, or `unreachable`. Liveness is
 * now **verified, not optimistic**: `servedOrigin` resolves to
 * `https://{publicHost}` **only** while `status === 'verified'` (a
 * `/health` probe through the public origin came back `pass` from this
 * device), otherwise the loopback fallback. `running` is the coarse
 * "a supervisor is attempting" view (`true` for `dialing`/`verified`/
 * `unreachable`), retained for back-compat — prefer `status`. `error`
 * is set for `misconfigured`/`unreachable`.
 *
 * `dialAttempts` counts dial attempts the live supervisor has made for this
 * revision (resets on the next reconcile) — a counter that climbs with
 * no recovery flags a permanent misconfiguration.
 *
 * `settingsRevision` / `dialAttempts` are `i64` on the Rust side; as monotonic
 * counters they stay well under `2^53`. `Schema.Int` (not `Schema.Number`)
 * keeps the OpenAPI type `integer`, matching utoipa's `i64` so the
 * spec-drift contract test agrees on the wire kind.
 */
const TunnelStateViewSchema = Schema.Struct({
  settingsRevision: Schema.Int,
  publicHost: Schema.NullOr(Schema.String),
  requestedRunning: Schema.Boolean,
  status: Schema.Literal('off', 'misconfigured', 'dialing', 'verified', 'unreachable'),
  running: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  dialAttempts: Schema.Int,
  servedOrigin: Schema.String,
  relay: Schema.NullOr(RelayViewSchema),
})

/**
 * Write-only relay connection block — the four fields needed to dial the
 * user's own rathole relay. Mirrors the Rust `RelayInput`. Never
 * returned in {@link TunnelStateViewSchema}, so the client can only *set* it,
 * not echo it back.
 */
const RelayInputSchema = Schema.Struct({
  remoteAddr: Schema.String,
  token: Schema.String,
  publicKey: Schema.String,
  serviceName: Schema.String,
})

/**
 * `PUT /tunnel` body — a **full replace** of the visible settings,
 * guarded by `settingsRevision` (mirrors the Rust `ReplaceTunnelRequestBody`).
 *
 * `publicHost` is required *and* nullable: it must be present in every
 * PUT (full-replace semantics — omitting it on the Rust side is
 * rejected), and `null` clears a configured host. `relay` is the only
 * intentionally-omittable member — it's write-only, so the client can't
 * echo what it never saw; absent means "keep the stored relay", present
 * means "replace all four fields".
 */
const ReplaceTunnelRequestBodySchema = Schema.Struct({
  settingsRevision: Schema.Int,
  publicHost: Schema.NullOr(Schema.String),
  requestedRunning: Schema.Boolean,
  relay: Schema.optional(RelayInputSchema),
})

/**
 * `403` body — the caller authenticated, but their token doesn't cover the
 * `/tunnel` scope the operation requires (`wildflower/TunnelSettings.r` to read,
 * `.u` to replace). Matches the shared Rust `InsufficientScopeBody`
 * (`scope-capabilities-rust`); `missingScopes` names the scopes the caller must
 * additionally hold.
 */
const InsufficientScopeSchema = Schema.Struct({
  error: Schema.Literal('InsufficientScope'),
  missingScopes: Schema.Array(Schema.String),
})

/**
 * `400` body — a `PUT /tunnel` whose `publicHost` isn't a bare `host[:port]`
 * naming an `https://` origin (a scheme, path, query or credentials, say).
 * Nothing is written. Matches the Rust `InvalidPublicHostBody`.
 */
const InvalidPublicHostSchema = Schema.Struct({
  error: Schema.Literal('InvalidPublicHost'),
  message: Schema.String,
})

/**
 * Why a bearer gate refused a logged request with a `401`. Mirrors the Rust
 * `RequestRefusalBody`.
 */
const RequestRefusalSchema = Schema.Literal('missingToken', 'tokenRejected', 'revoked')

/**
 * What the request log holds for one (caller, client address) pair — a row of
 * `GET /tunnel/activity`, mirroring the Rust `RequestActivityBody`. `clientId`
 * is `null` for the requests no bearer gate verified; resolve a client's
 * display name through gatekeeper's client list. `refusedCount` counts a
 * bearer gate's `401`s and scope `403`s.
 */
const RequestActivitySchema = Schema.Struct({
  clientId: Schema.NullOr(Schema.String),
  address: Schema.NullOr(Schema.String),
  firstSeen: Schema.DateTimeUtc,
  lastSeen: Schema.DateTimeUtc,
  requestCount: Schema.Int,
  refusedCount: Schema.Int,
  lastStatus: Schema.Int,
  lastRefusal: Schema.NullOr(RequestRefusalSchema),
})

/**
 * One request in the log — an element of `GET /tunnel/requests`, mirroring the
 * Rust `LoggedRequestBody`. `path` is the route the request was reduced to (no
 * ids, no query string); a higher `id` is newer.
 */
const LoggedRequestSchema = Schema.Struct({
  id: Schema.Int,
  receivedAt: Schema.DateTimeUtc,
  clientId: Schema.NullOr(Schema.String),
  address: Schema.NullOr(Schema.String),
  servedHost: Schema.NullOr(Schema.String),
  method: Schema.String,
  path: Schema.String,
  status: Schema.Int,
  responseBytes: Schema.NullOr(Schema.Int),
  durationMs: Schema.Int,
  refusal: Schema.NullOr(RequestRefusalSchema),
})

/**
 * One page of `GET /tunnel/requests`, newest first — mirrors the Rust
 * `RequestLogPageBody`. `nextCursor` is the `cursor` that reads the next page,
 * `null` on the last one.
 */
const RequestLogPageSchema = Schema.Struct({
  requests: Schema.Array(LoggedRequestSchema),
  nextCursor: Schema.NullOr(Schema.Int),
})

/**
 * `GET /tunnel/requests` query — mirrors the Rust `ListRequestsParams`. Every
 * parameter is optional, and every one given must match: `cursor` is the
 * previous page's `nextCursor`, `client` a verified caller's OAuth client,
 * `address` a client address, and `refused` keeps only the refused requests
 * (`true`) or only the rest (`false`).
 *
 * A query string carries every value as text, so `cursor` and `refused` decode
 * from strings; their `jsonSchema` annotations document the value each string
 * holds, as the server's spec does (`integer`, `boolean`).
 */
const ListRequestsUrlParamsSchema = Schema.Struct({
  cursor: Schema.optional(
    Schema.compose(Schema.NumberFromString, Schema.Int).annotations({
      jsonSchema: { type: 'integer' },
    })
  ),
  client: Schema.optional(Schema.String),
  address: Schema.optional(Schema.String),
  refused: Schema.optional(
    Schema.BooleanFromString.annotations({ jsonSchema: { type: 'boolean' } })
  ),
})

/**
 * The fresh-install tunnel snapshot — every counter at zero, every nullable
 * `null`, the server bound to its loopback fallback. The single canonical
 * sample shared by the slice's tests, so the fixture doesn't drift across
 * packages when a field is added.
 */
const freshTunnelState: Schema.Schema.Type<typeof TunnelStateViewSchema> = {
  settingsRevision: 0,
  publicHost: null,
  requestedRunning: false,
  status: 'off',
  running: false,
  error: null,
  dialAttempts: 0,
  servedOrigin: 'http://127.0.0.1:8080',
  relay: null,
}

/**
 * Tunnel-state and request-log endpoints. The group carries no middleware —
 * auth is applied by the host. In the Tauri app the Rust server gates `/tunnel`
 * behind the gatekeeper Owner check; the TS client layer still attaches
 * the bearer (see `tunnel-react/src/client/tunnel-client.ts`).
 *
 * Every endpoint is scope-gated on the Rust side — `GetTunnel`, `GetActivity`
 * and `ListRequests` by `wildflower/TunnelSettings.r`, `ReplaceTunnel` by
 * `wildflower/TunnelSettings.u` — returning a `403 InsufficientScope` when the
 * token doesn't cover it.
 *
 * `GetActivity` reads the request log grouped by (caller, client address), the
 * group with the newest request first; `ListRequests` reads it one page at a
 * time, newest first, keyset-paged on id through `cursor`.
 *
 * `ReplaceTunnel` is a full-replace `PUT`:
 * - **200** returns the new snapshot after the write applied and the
 *   daemon reconciled.
 * - **400** `publicHost` isn't a bare `host[:port]`; nothing was written.
 * - **403** the token doesn't cover `wildflower/TunnelSettings.u` (see above).
 * - **409** returns the *current* snapshot (same {@link TunnelStateViewSchema}
 *   shape, with the newer `settingsRevision`) because the caller's `settingsRevision`
 *   was stale — no partial write happened. The client surfaces this in
 *   the error channel as a `TunnelState` value; discriminate it with
 *   `Schema.is(TunnelStateViewSchema)`.
 */
const httpApiGroup = HttpApiGroup.make('tunnel', { topLevel: false })
  .add(
    HttpApiEndpoint.get('GetTunnel', '/tunnel')
      .addSuccess(TunnelStateViewSchema)
      .addError(InsufficientScopeSchema, { status: 403 })
  )
  .add(
    HttpApiEndpoint.put('ReplaceTunnel', '/tunnel')
      .setPayload(ReplaceTunnelRequestBodySchema)
      .addSuccess(TunnelStateViewSchema)
      .addError(InvalidPublicHostSchema, { status: 400 })
      .addError(InsufficientScopeSchema, { status: 403 })
      .addError(TunnelStateViewSchema, { status: 409 })
  )
  .add(
    HttpApiEndpoint.get('GetActivity', '/tunnel/activity')
      .addSuccess(Schema.Array(RequestActivitySchema))
      .addError(InsufficientScopeSchema, { status: 403 })
  )
  .add(
    HttpApiEndpoint.get('ListRequests', '/tunnel/requests')
      .setUrlParams(ListRequestsUrlParamsSchema)
      .addSuccess(RequestLogPageSchema)
      .addError(InsufficientScopeSchema, { status: 403 })
  )

export {
  freshTunnelState,
  httpApiGroup,
  InsufficientScopeSchema,
  InvalidPublicHostSchema,
  ListRequestsUrlParamsSchema,
  LoggedRequestSchema,
  RelayInputSchema,
  RelayViewSchema,
  ReplaceTunnelRequestBodySchema,
  RequestActivitySchema,
  RequestLogPageSchema,
  RequestRefusalSchema,
  TunnelStateViewSchema,
}
