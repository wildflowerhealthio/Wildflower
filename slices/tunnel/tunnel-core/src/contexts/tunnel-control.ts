import { Context, Data, type Effect } from 'effect'

class TunnelUnavailable extends Data.TaggedError('TunnelUnavailable')<{
  readonly reason: string
}> {}

/**
 * The tunnel feature's externally-visible state. `publicOrigin` is the
 * URL the server is reachable at (the tunnel URL when `active`, the
 * `localOrigin` otherwise); `localOrigin` is the loopback origin the
 * tunnel forwards to (or that callers hit directly when `active` is
 * false). Carries `port` so non-tunnel consumers can compose URLs
 * without re-parsing.
 */
interface TunnelState {
  readonly active: boolean
  readonly publicOrigin: string
  readonly localOrigin: string
  readonly port: number
}

interface TunnelControlService {
  readonly getState: Effect.Effect<TunnelState>
  readonly setActive: (active: boolean) => Effect.Effect<TunnelState, TunnelUnavailable>
}

class TunnelControl extends Context.Tag('tunnel-core/TunnelControl')<
  TunnelControl,
  TunnelControlService
>() {}

export { TunnelControl, TunnelUnavailable }
export type { TunnelControlService, TunnelState }
