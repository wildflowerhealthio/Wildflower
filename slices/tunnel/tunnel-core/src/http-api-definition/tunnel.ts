import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

/**
 * Tunnel state on the wire — mirrors the Rust `TunnelStateResponse`
 * (`slices/tunnel/tunnel-rust/.../tunnel_state_response.rs`,
 * `#[serde(rename_all = "camelCase")]`). Relay connection details are
 * write-only and never appear here.
 *
 * `revision` is the optimistic-concurrency token: a PUT must echo the
 * last-seen revision, and a stale one is rejected with `409` (see
 * {@link httpApiGroup}).
 *
 * `running` is **optimistic** — it flips `true` the instant a dial
 * attempt starts and stays true across reconnect attempts that haven't
 * errored yet. It means *dialing*, not *connected*; rathole exposes no
 * "handshake completed" signal. `servedOrigin` derives from `running`,
 * so it may resolve to `https://{publicHost}` mid-dial. A consumer that
 * needs *verified reachable* must probe the URL itself.
 *
 * `attempt` counts dial attempts the live supervisor has made for this
 * revision (resets on the next reconcile) — a counter that climbs with
 * no recovery flags a permanent misconfiguration.
 *
 * `revision` / `attempt` are `i64` on the Rust side; as monotonic
 * counters they stay well under `2^53`, so `Schema.Number` matches the
 * JSON wire exactly.
 */
const TunnelStateSchema = Schema.Struct({
  revision: Schema.Number,
  publicHost: Schema.NullOr(Schema.String),
  requestedRunning: Schema.Boolean,
  running: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  attempt: Schema.Number,
  servedOrigin: Schema.String,
})

/**
 * Write-only relay connection block — the four fields needed to dial the
 * self-hosted rathole relay. Mirrors the Rust `RelayInput`. Never
 * returned in {@link TunnelStateSchema}, so the client can only *set* it,
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
 * guarded by `revision` (mirrors the Rust `ReplaceTunnelRequestBody`).
 *
 * `publicHost` is required *and* nullable: it must be present in every
 * PUT (full-replace semantics — omitting it on the Rust side is
 * rejected), and `null` clears a configured host. `relay` is the only
 * intentionally-omittable member — it's write-only, so the client can't
 * echo what it never saw; absent means "keep the stored relay", present
 * means "replace all four fields".
 */
const ReplaceTunnelRequestBodySchema = Schema.Struct({
  revision: Schema.Number,
  publicHost: Schema.NullOr(Schema.String),
  requestedRunning: Schema.Boolean,
  relay: Schema.optional(RelayInputSchema),
})

/**
 * Tunnel-state endpoints. The group carries no middleware — auth is
 * applied by the host. In the Tauri app the Rust server gates `/tunnel`
 * behind the gatekeeper Owner check; the TS client layer still attaches
 * the bearer (see `tunnel-react/src/client/tunnel-client.ts`).
 *
 * `ReplaceTunnel` is a full-replace `PUT`:
 * - **200** returns the new snapshot after the write applied and the
 *   daemon reconciled.
 * - **409** returns the *current* snapshot (same {@link TunnelStateSchema}
 *   shape, with the newer `revision`) because the caller's `revision`
 *   was stale — no partial write happened. The client surfaces this in
 *   the error channel as a `TunnelState` value; discriminate it with
 *   `Schema.is(TunnelStateSchema)`.
 */
const httpApiGroup = HttpApiGroup.make('tunnel', { topLevel: false })
  .add(HttpApiEndpoint.get('GetTunnel', '/tunnel').addSuccess(TunnelStateSchema))
  .add(
    HttpApiEndpoint.put('ReplaceTunnel', '/tunnel')
      .setPayload(ReplaceTunnelRequestBodySchema)
      .addSuccess(TunnelStateSchema)
      .addError(TunnelStateSchema, { status: 409 })
  )

export { httpApiGroup, RelayInputSchema, ReplaceTunnelRequestBodySchema, TunnelStateSchema }
