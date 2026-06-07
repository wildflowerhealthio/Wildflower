import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, type Store } from '@livestore/livestore'
import { makeLoopbackSyncBackend } from 'shared-structures-core/livestore'
import { getLivestoreOtelOptions, injectActiveOtelContext } from 'telemetry-core/livestore'
import { schema } from './schema.ts'
import { SERVICE_NAME } from './service-name.ts'

const adapter = makeAdapter({
  storage: { type: 'fs' },
  // An in-memory loopback backend drains LiveStore's `pending` array, which
  // otherwise grows to the size of the whole eventlog on a local-only store
  // and makes every `store.commit` O(eventlog). See `makeLoopbackSyncBackend`.
  sync: { backend: makeLoopbackSyncBackend() },
})

const createStore = async (): Promise<Store<typeof schema, object>> => {
  const store = await createStorePromise({
    adapter,
    schema,
    storeId: 'livestore-data',
    otelOptions: getLivestoreOtelOptions(SERVICE_NAME),
  })
  return injectActiveOtelContext(store)
}

export { createStore }
