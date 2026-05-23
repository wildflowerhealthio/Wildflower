import {
  type EventDef,
  type Store as LivestoreStore,
  State,
  makeSchema,
} from '@livestore/livestore'
import { Context, Layer } from 'effect'

/**
 * Shape of the `tables` record accepted by `State.SQLite.makeState`.
 * Re-exported so consumers that build the record outside the
 * {@link defineSliceLivestore} call (e.g. via spreading) can annotate
 * it without re-deriving livestore's internal `Materializer<any>` shape.
 */
type InputTables = State.SQLite.InputState['tables']

/**
 * Shape of the `materializers` record accepted by
 * `State.SQLite.makeState`. Re-exported for the same reason as
 * {@link InputTables}.
 */
type InputMaterializers = State.SQLite.InputState['materializers']

/**
 * Bundle a slice's livestore boilerplate into one declaration.
 *
 * Composes `State.SQLite.makeState({ tables, materializers })` and
 * `makeSchema({ events, state })` from the slice-supplied records, and
 * returns the derived `schema` / `state` plus two factories the slice
 * uses to wire a `Context.Tag` into the rest of its Effect graph:
 *
 *  - `StoreTag<Self>()` returns the result of
 *    `Context.Tag(name)<Self, Store<typeof schema, object>>()` (its
 *    return type is intentionally inferred, not the bare
 *    `Context.TagClass<...>` interface, so callers can still reach for
 *    `typeof MyStore.Service` / `MyStore.Identifier`). The slice extends
 *    from this so its class name (`EmrStore`, etc.) remains both a
 *    value and a type alias, exactly like the standalone
 *    `Context.Tag(name)<Self, Service>()` pattern.
 *  - `makeLayerFactory(Tag)` returns `(store) => Layer.Layer<Self>` for a
 *    `Store<TSchema, object>` whose schema is a *superset* of the
 *    slice's own (so app-level schemas that spread the slice's
 *    tables/events/materializers in are accepted). `Store` is invariant
 *    in its schema parameter, so a single `as unknown as` cast lives
 *    here and the input boundary is verified via the
 *    `TSchema extends typeof schema` constraint. The slice typically
 *    attaches the result as a `static readonly layerFrom` on the
 *    `Context.Tag` class so callers reach for `EmrStore.layerFrom(store)`.
 *
 * @example
 * ```ts
 * import { defineSliceLivestore } from 'shared-structures-core/livestore'
 *
 * const { schema, state, StoreTag, makeLayerFactory } = defineSliceLivestore({
 *   name: 'EmrStore',
 *   tables,
 *   events,
 *   materializers,
 * })
 *
 * class EmrStore extends StoreTag<EmrStore>() {
 *   static readonly layerFrom = makeLayerFactory(EmrStore)
 * }
 *
 * export { EmrStore, schema, state }
 * ```
 */
// Explicit return type would have to re-express the derived schema's
// shape (`FromInputSchema.DeriveSchema<{events, state: InternalState}>`)
// plus the `StoreTag` / `layerFrom` factories — a builder result that
// reads more clearly when inferred. Existing slice helpers
// (`apps-core/src/livestore/app-selection.ts`,
// `collector-core/src/livestore/remote-config.ts`) take the same
// approach for query factories.
const defineSliceLivestore = <
  const Name extends string,
  TEvents extends Record<string, EventDef.AnyWithoutFn>,
>(input: {
  readonly name: Name
  readonly tables: InputTables
  readonly events: TEvents
  readonly materializers: InputMaterializers
  // oxlint-disable-next-line typescript/explicit-function-return-type
}) => {
  const state = State.SQLite.makeState({
    tables: input.tables,
    materializers: input.materializers,
  })
  const schema = makeSchema({ events: input.events, state })

  type Service = LivestoreStore<typeof schema, object>

  // No explicit return type: forwarding the concrete `Context.Tag(name)<Self, Service>()`
  // result preserves the static `.Service` / `.Identifier` accessors that callers
  // reach for via `typeof MyStore.Service`. Annotating with the bare
  // `Context.TagClass<Self, Name, Service>` interface strips those.
  // oxlint-disable-next-line typescript/explicit-function-return-type
  const StoreTag = <Self>() => Context.Tag(input.name)<Self, Service>()

  const makeLayerFactory =
    <Self>(Tag: Context.Tag<Self, Service>) =>
    <TSchema extends typeof schema>(store: LivestoreStore<TSchema, object>): Layer.Layer<Self> =>
      // Store is invariant in its schema parameter, so even though the
      // `TSchema extends typeof schema` constraint guarantees the input
      // is a superset, TypeScript can't widen the value to the slice's
      // narrower schema. This is the only cast the helper introduces.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      Layer.succeed(Tag, store as unknown as Service)

  return { schema, state, StoreTag, makeLayerFactory } as const
}

export { defineSliceLivestore }
export type { InputTables, InputMaterializers }
export { subscribeUntil } from './subscribeUntil.ts'
export type { QueryableSubscribableStore } from './subscribeUntil.ts'
