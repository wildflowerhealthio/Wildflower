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
 * (`slices/tunnel/tunnel-rust/.../tunnel_state_response.rs`,
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
 * self-hosted rathole relay. Mirrors the Rust `RelayInput`. Never
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
 * Tunnel-state endpoints. The group carries no middleware — auth is
 * applied by the host. In the Tauri app the Rust server gates `/tunnel`
 * behind the gatekeeper Owner check; the TS client layer still attaches
 * the bearer (see `tunnel-react/src/client/tunnel-client.ts`).
 *
 * `ReplaceTunnel` is a full-replace `PUT`:
 * - **200** returns the new snapshot after the write applied and the
 *   daemon reconciled.
 * - **409** returns the *current* snapshot (same {@link TunnelStateViewSchema}
 *   shape, with the newer `settingsRevision`) because the caller's `settingsRevision`
 *   was stale — no partial write happened. The client surfaces this in
 *   the error channel as a `TunnelState` value; discriminate it with
 *   `Schema.is(TunnelStateViewSchema)`.
 */
const httpApiGroup = HttpApiGroup.make('tunnel', { topLevel: false })
  .add(HttpApiEndpoint.get('GetTunnel', '/tunnel').addSuccess(TunnelStateViewSchema))
  .add(
    HttpApiEndpoint.put('ReplaceTunnel', '/tunnel')
      .setPayload(ReplaceTunnelRequestBodySchema)
      .addSuccess(TunnelStateViewSchema)
      .addError(TunnelStateViewSchema, { status: 409 })
  )

export {
  freshTunnelState,
  httpApiGroup,
  RelayInputSchema,
  RelayViewSchema,
  ReplaceTunnelRequestBodySchema,
  TunnelStateViewSchema,
}
