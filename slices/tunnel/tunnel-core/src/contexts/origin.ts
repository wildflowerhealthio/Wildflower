import { Effect, Layer, Subscribable } from 'effect'
import { LocalHttpServerStore } from 'local-http-server-core/livestore'
import { Origin } from 'navigation-core'

import { TunnelStore } from '../livestore/index.ts'
import { servedOrigin$ } from '../livestore/served-origin.ts'

/**
 * `Origin` Layer wired from the tunnel slice's `servedOrigin$` computed
 * query. The Subscribable's `get` re-reads `servedOrigin$` on every
 * call, and `changes` streams updates via the livestore subscription —
 * so consumers of `Origin` see the live origin (tunnel URL when up,
 * loopback otherwise) without any direct dependency on the tunnel /
 * local-http-server stores.
 *
 * Apps wire this Layer once at composition time, scoping the
 * `TunnelStore | LocalHttpServerStore` requirement to one location.
 */
const OriginFromServedOrigin: Layer.Layer<Origin, never, TunnelStore | LocalHttpServerStore> =
  Layer.effect(
    Origin,
    Effect.gen(function* () {
      const tunnelStore = yield* TunnelStore
      // Type-only assertion that the LHS table is in the composed schema.
      yield* LocalHttpServerStore
      return Subscribable.make({
        get: Effect.sync(() => tunnelStore.query(servedOrigin$)),
        changes: tunnelStore.subscribeStream(servedOrigin$),
      })
    })
  )

export { OriginFromServedOrigin }
