import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, type Store } from '@livestore/livestore'
import { getLivestoreOtelOptions, injectActiveOtelContext } from 'telemetry-core/livestore'
import { schema } from './schema.ts'
import { SERVICE_NAME } from './service-name.ts'

const adapter = makeAdapter({
  storage: { type: 'fs' },
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
