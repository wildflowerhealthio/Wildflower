/**
 * NO-OP tunnel control seams for the apps-expo host binding.
 *
 * The livestore-driven tunnel daemon (commit `requestedRunning` on
 * `TunnelConfig`, await `running` on `TunnelState`) was removed with the rest
 * of the TS server stack. These functions keep the host binding's start/stop
 * + await-origin shape (see `host-handlers.ts`'s `RequestTunnel`) so a later
 * PR can rewire them to the Rust tunnel (`tunnel-rust`: `PUT /tunnel
 * { requestedRunning }`, then poll `GET /tunnel` for `servedOrigin`).
 *
 * This file is reference scaffolding — it is not wired into any running app
 * today (wildflower-expo, its only consumer, was removed). Until rewired,
 * starting/stopping is a no-op and awaiting the origin fails immediately with
 * {@link TunnelTimedOut}, so `RequestTunnel` replies `TunnelFailed` and the
 * web side falls back to its local origin.
 */
import { Duration, Effect, Schema } from 'effect'

const TUNNEL_AWAIT_TIMEOUT: Duration.Duration = Duration.seconds(15)

/** Failure raised when the tunnel never reports a bound public origin. */
class TunnelTimedOut extends Schema.TaggedError<TunnelTimedOut>()('TunnelTimedOut', {
  timeoutMs: Schema.Number,
}) {}

/**
 * Start (`active = true`) or stop (`active = false`) the tunnel — NO-OP.
 *
 * Rewire to `PUT /tunnel { requestedRunning: active }` on the Rust tunnel.
 */
const commitRequestedRunning = (_active: boolean): Effect.Effect<void> => Effect.void

/**
 * Resolve the tunnel's public origin once bound, else fail with
 * {@link TunnelTimedOut} — NO-OP, always fails immediately.
 *
 * Rewire to poll the Rust tunnel's `GET /tunnel` for `servedOrigin` once
 * `running`.
 */
const awaitTunnelOrigin = (
  timeout: Duration.Duration = TUNNEL_AWAIT_TIMEOUT
): Effect.Effect<string, TunnelTimedOut> =>
  Effect.fail(new TunnelTimedOut({ timeoutMs: Duration.toMillis(timeout) }))

export { awaitTunnelOrigin, commitRequestedRunning, TunnelTimedOut }
