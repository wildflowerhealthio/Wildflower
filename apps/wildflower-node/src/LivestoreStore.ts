import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, type Store } from '@livestore/livestore'
import { Array } from 'effect'
import { JsonWebKeys } from 'gatekeeper-core/livestore'
import { getLivestoreOtelOptions, injectActiveOtelContext } from 'telemetry-core/livestore'
import { events, schema } from './schema.ts'

const adapter = makeAdapter({
  storage: { type: 'fs' },
})

const createStore = async (): Promise<Store<typeof schema, object>> => {
  const store = await createStorePromise({
    adapter,
    schema,
    storeId: 'livestore-data',
    otelOptions: getLivestoreOtelOptions('wildflower-node'),
  })
  const jsonWebKeys = store.query(JsonWebKeys.queries.allJwks$)
  if (!Array.isNonEmptyReadonlyArray(jsonWebKeys)) {
    const jwk = await JsonWebKeys.RsaJwk.generate()
    store.commit(events.jwkAdded({ rsaJwk: jwk }))
  }
  return injectActiveOtelContext(store)
}

export { createStore }
export type { schema }
