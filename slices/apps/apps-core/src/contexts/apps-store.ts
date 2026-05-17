import type { Store } from '@livestore/livestore'
import { Context, Layer } from 'effect'
import type { schema } from '../livestore/index.ts'

class AppsStore extends Context.Tag('AppsStore')<AppsStore, Store<typeof schema, object>>() {}

const makeAppsStoreLayer = <TSchema extends typeof schema>(
  store: Store<TSchema, object>
): Layer.Layer<AppsStore, never, never> =>
  // oxlint-disable-next-line typescript/no-explicit-any typescript/no-unsafe-type-assertion
  Layer.succeed(AppsStore, store as unknown as Store<typeof schema, object>)

export { AppsStore, makeAppsStoreLayer }
