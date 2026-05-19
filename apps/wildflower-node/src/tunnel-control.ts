import { type ServerState, TunnelControl, TunnelUnavailable } from 'apps-core/contexts'
import { Effect, Layer } from 'effect'

/**
 * Node host has no tunnel — the server is reachable at a fixed origin
 * (set via `ORIGIN` / `PORT` env vars). `TunnelControl` returns the
 * static state and rejects every `setTunnelActive` call.
 *
 * @remarks
 * A future Expo / mobile host will install a different Live Layer that
 * actually controls a tunnel (e.g. via `expo-localtunnel`).
 */
const TunnelControlLive = (state: ServerState): Layer.Layer<TunnelControl, never, never> =>
  Layer.succeed(TunnelControl, {
    getState: Effect.succeed(state),
    setTunnelActive: () =>
      Effect.fail(
        new TunnelUnavailable({
          reason: 'Node host has no tunnel; tunnel state is fixed at startup.',
        })
      ),
  })

export { TunnelControlLive }
