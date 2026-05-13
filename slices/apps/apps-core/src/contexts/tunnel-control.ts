import { Context, Data, type Effect } from 'effect'

class TunnelUnavailable extends Data.TaggedError('TunnelUnavailable')<{
  readonly reason: string
}> {}

interface ServerState {
  readonly origin: string
  readonly localOrigin: string
  readonly port: number
  readonly tunnelActive: boolean
}

interface TunnelControlService {
  readonly getState: Effect.Effect<ServerState>
  readonly setTunnelActive: (active: boolean) => Effect.Effect<ServerState, TunnelUnavailable>
}

class TunnelControl extends Context.Tag('apps-core/TunnelControl')<
  TunnelControl,
  TunnelControlService
>() {}

export { TunnelControl, TunnelUnavailable }
export type { TunnelControlService, ServerState }
