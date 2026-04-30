import type { Store } from '@livestore/livestore'
import { Context, Layer } from 'effect'
import type { schema } from '../livestore/index.ts'

class LivestoreStore extends Context.Tag('LivestoreStore')<
  LivestoreStore,
  Store<typeof schema, object>
>() {}

// Callers pass a `Store` whose schema is a *superset* of store-core's
// `schema` (e.g. an app-level schema that spreads in `events`/`tables`/
// `materializers` from this package). `TSchema extends typeof schema`
// enforces that on the input, but `Store` is invariant in its schema
// parameter, so the value still needs a cast to land in the
// `Store<typeof schema, object>`-typed Tag. The cast is `unknown` →
// `Store<typeof schema, object>` rather than `→ Store<any, object>` so
// downstream consumers see the narrowed schema, not `any`.
const makeLivestoreStoreLayer = <TSchema extends typeof schema>(
  store: Store<TSchema, object>
): Layer.Layer<LivestoreStore> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  Layer.succeed(LivestoreStore, store as unknown as Store<typeof schema, object>)

export { LivestoreStore, makeLivestoreStoreLayer }
