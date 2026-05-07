import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, type Store } from '@livestore/livestore'
import { Array } from 'effect'
import { SigningKey } from 'gatekeeper-core/livestore'
import { getLivestoreOtelOptions, injectActiveOtelContext } from 'telemetry-core/livestore'
import { events, schema } from 'wildflower-server/schema'

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
    // `signingKeyAdded` materialises with `isActive: false`; without the
    // follow-up `signingKeyActivated` the active$ query stays empty forever
    // and sign-side callers fall through to `all[0]`. Activate the
    // freshly-added key so `isActive` is load-bearing on the column it
    // claims to be.
    store.commit(
      events.signingKeyAdded({ signingKey }),
      events.signingKeyActivated({ kid: signingKey.kid })
    )
  }
  return injectActiveOtelContext(store)
}

export { createStore }
export type { schema }
