import { Context, type Effect } from 'effect'

interface PublicOriginService {
  /**
   * Resolve the current public origin (e.g. the live `currentPublicOrigin`
   * from `TunnelStore`, falling back to the local server's loopback on
   * expo; static `ORIGIN` on node). Always read at call time — consumers
   * compose absolute URLs that need to reflect the current tunnel state.
   */
  readonly get: Effect.Effect<string>
}

/**
 * Public-facing origin used to compose absolute URLs that need to be
 * reachable from outside the device (OAuth redirect URIs, launch URLs,
 * etc.). Separate from `Origin` (which is always the local loopback)
 * because the public origin changes as the tunnel comes up / down.
 */
class PublicOrigin extends Context.Tag('tunnel-core/PublicOrigin')<
  PublicOrigin,
  PublicOriginService
>() {}

export { PublicOrigin }
export type { PublicOriginService }
