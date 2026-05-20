import { makePersistedAdapter } from '@livestore/adapter-expo'
import type { Store } from '@livestore/livestore'
import { type ReactApi, useStore } from '@livestore/react'
import { Context } from 'effect'
import { ServerState } from 'local-http-server-core/livestore'
import { unstable_batchedUpdates as batchUpdates } from 'react-native'
import { getLivestoreOtelOptions } from 'telemetry-react-native'
import { SERVICE_NAME } from '../constants.ts'
import { events as schemaEvents, schema } from './schema.ts'

const adapter = makePersistedAdapter({
  storage: {
    subDirectory: 'wildflower-db',
  },
})

/**
 * Subscribe to the singleton wildflower LiveStore. Suspends until the
 * store is loaded; once loaded, subsequent calls return synchronously
 * via the `StoreRegistry` cache. `otelOptions` is evaluated lazily so a
 * real tracer is wired in only after telemetry init has fired.
 *
 * The `boot` callback fires once per store creation; we use it to
 * commit `requestedRunning: true` so the local-http-server-expo daemon
 * starts serving as soon as the store is ready. Subsequent restarts of
 * the React tree see `requestedRunning: true` already on the session
 * client document and don't need to re-commit.
 */
const useWildflowerStore = (): Store<typeof schema, object> & ReactApi =>
  useStore({
    storeId: 'wildflower-store',
    schema,
    adapter,
    batchUpdates,
    otelOptions: getLivestoreOtelOptions(SERVICE_NAME),
    boot: (store) => {
      const current = store.query(ServerState.queries.current$)
      if (!current.requestedRunning) {
        store.commit(schemaEvents.localHttpServerStateSet({ requestedRunning: true }))
      }
    },
  })

class WildflowerStore extends Context.Tag('WildflowerStore')<
  WildflowerStore,
  Store<typeof schema, object>
>() {}

export { useWildflowerStore, WildflowerStore }
