import { type ServerState, TunnelControl, TunnelUnavailable } from 'apps-core/contexts'
import { Effect, Layer } from 'effect'

const TunnelControlLive = (state: ServerState): Layer.Layer<TunnelControl> =>
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
