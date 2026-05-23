import { Effect, Layer, Stream, Subscribable } from 'effect'
import { LocalHttpServerStore } from 'local-http-server-core/livestore'
import { Origin } from 'navigation-core'

import { TunnelStore } from '../livestore/index.ts'
import { servedOrigin$ } from '../livestore/served-origin.ts'

/**
 * `Origin` Layer wired from {@link servedOrigin$} — tunnel URL when up,
 * loopback otherwise. Extracts the `.origin` URL from the tagged
 * `ServedOrigin` so the `Subscribable<string>` surface stays flat.
 */
const OriginFromServedOrigin: Layer.Layer<Origin, never, TunnelStore | LocalHttpServerStore> =
  Layer.effect(
    Origin,
    Effect.gen(function* () {
      const tunnelStore = yield* TunnelStore
      // Surface LHS as a Layer requirement so app composers must provide it;
      // `servedOrigin$` reads `ServerState` via the underlying livestore and
      // would throw at query time if the schema were missing the table.
      yield* LocalHttpServerStore
      return Subscribable.make({
        get: Effect.sync(() => tunnelStore.query(servedOrigin$).origin),
        changes: tunnelStore.subscribeStream(servedOrigin$).pipe(Stream.map((s) => s.origin)),
      })
    })
  )

export { OriginFromServedOrigin }
