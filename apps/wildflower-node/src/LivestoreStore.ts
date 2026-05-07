import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, type Store } from '@livestore/livestore'
import { Array } from 'effect'
import { SigningKey } from 'gatekeeper-core/livestore'
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
  const signingKeys = store.query(SigningKey.queries.all$)
  if (!Array.isNonEmptyReadonlyArray(signingKeys)) {
    const signingKey = await SigningKey.generate()
    store.commit(events.signingKeyAdded({ signingKey }))
  }
  return injectActiveOtelContext(store)
}

export { createStore }
export type { schema }
