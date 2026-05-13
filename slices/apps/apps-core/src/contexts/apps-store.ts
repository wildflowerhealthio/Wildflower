import type { Store } from '@livestore/livestore'
import { Context, Layer } from 'effect'
import type { schema } from '../livestore/index.ts'

class AppsStore extends Context.Tag('AppsStore')<AppsStore, Store<typeof schema, object>>() {}

const makeAppsStoreLayer = <TSchema extends typeof schema>(
  store: Store<TSchema, object>
  // oxlint-disable-next-line typescript/no-explicit-any typescript/no-unsafe-type-assertion
): Layer.Layer<AppsStore> => Layer.succeed(AppsStore, store as Store<any, object>)

export { AppsStore, makeAppsStoreLayer }
