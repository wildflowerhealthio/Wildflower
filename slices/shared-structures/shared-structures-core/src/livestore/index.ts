import {
  type EventDef,
  type FromInputSchema,
  type InternalState,
  type Store as LivestoreStore,
  State,
  makeSchema,
} from '@livestore/livestore'
import { Context, Layer } from 'effect'
import type { UnionToIntersection } from 'kitchen-sink/types'

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

/**
 * Record arm of `State.SQLite.InputState['tables']` — exclude the
 * `ReadonlyArray<TableDefBase>` alternative so consumers can spread the
 * slice's tables map safely. Slices always supply a keyed record, never
 * a positional array.
 */
type SliceTables = Extract<InputTables, Record<string, unknown>>

/**
 * Module shape accepted by {@link composeLivestoreModules}. Each slice's
 * `livestore/index.ts` exports exactly this surface, so the helper can
 * blindly spread the records together without knowing the concrete
 * source. Generic in all three records so an inferred module preserves
 * the slice's exact table / event / materializer keys — the composed
 * `events` / `schema` / `tables` are typed by intersecting these. No
 * defaults: callers either pass concrete types or let inference fill
 * them in from a value (e.g. an `as const` array of slice records).
 */
type LivestoreModule<
  TTables extends SliceTables,
  TEvents extends Record<string, EventDef.AnyWithoutFn>,
  TMaterializers extends InputMaterializers,
> = {
  readonly tables: TTables
  readonly events: TEvents
  readonly materializers: TMaterializers
}

/**
 * Output of {@link composeLivestoreModules}. Each composed record is the
 * intersection of its per-slice contributions, so callers retain literal
 * key types on `tables` / `events` / `materializers` and the
 * `schema.eventsDefsMap` carries every slice event. `state` stays
 * `InternalState` (LiveStore's `makeState` erases its concrete tables to
 * `Map<string, TableDef.Any>`); the `schema` type still threads the
 * intersected events through `FromInputSchema.DeriveSchema`.
 */
type ComposedLivestoreModule<
  TSlices extends ReadonlyArray<
    LivestoreModule<SliceTables, Record<string, EventDef.AnyWithoutFn>, InputMaterializers>
  >,
> = {
  readonly tables: UnionToIntersection<TSlices[number]['tables']>
  readonly events: UnionToIntersection<TSlices[number]['events']>
  readonly materializers: UnionToIntersection<TSlices[number]['materializers']>
  readonly state: InternalState
  // `FromInputSchema.DeriveSchema` requires `events extends Record<string,
  // EventDef.AnyWithoutFn>`. `UnionToIntersection<...>` alone doesn't
  // satisfy that, so we intersect with the constraint. The downside:
  // LiveStore's `EventDefRecordFromInputSchemaEvents` is a homomorphic
  // mapped type, and the added index signature widens `keyof events`
  // to `string`, collapsing the derived `_EventDefMapType` to broad
  // `string` keys. Per-event literal types stay reachable through
  // `composed.events` (which has no index sig), and the resulting
  // `LiveStoreSchema` stays structurally compatible with the schemas
  // `defineSliceLivestore` produces — required so each slice's
  // `<TSchema extends typeof sliceSchema>` constraint in `layerFrom`
  // accepts the composed store.
  readonly schema: FromInputSchema.DeriveSchema<{
    readonly events: UnionToIntersection<TSlices[number]['events']> &
      Record<string, EventDef.AnyWithoutFn>
    readonly state: InternalState
  }>
}

/**
 * Compose an app-level livestore schema from a list of slice
 * contributions. Each slice exposes `{ tables, events, materializers }`
 * via its `<name>-core/livestore` entry, and this helper threads them
 * into the `State.SQLite.makeState` / `makeSchema` pair that the app
 * needs.
 *
 * Enforces a single composition path so two apps cannot independently
 * drift in spread order — slice-ordering drift between different hosts'
 * schema files would break cross-host LiveStore syncs.
 *
 * The helper takes a tuple of slices (rather than a single varargs
 * spread) so the inferred `events` type is the intersection of every
 * slice's events — callers keep strongly-typed event-name autocomplete
 * on the returned `events` / `schema` instead of collapsing to a
 * `Record<string, EventDef.AnyWithoutFn>` union.
 *
 * @example
 * ```ts
 * import * as CollectorLivestore from 'collector-core/livestore'
 * import * as GatekeeperLivestore from 'gatekeeper-core/livestore'
 * import { composeLivestoreModules } from 'shared-structures-core/livestore'
 *
 * const { events, schema, tables } = composeLivestoreModules([
 *   CollectorLivestore,
 *   GatekeeperLivestore,
 * ] as const)
 * ```
 */
const composeLivestoreModules = <
  const TSlices extends ReadonlyArray<
    LivestoreModule<SliceTables, Record<string, EventDef.AnyWithoutFn>, InputMaterializers>
  >,
>(
  slices: TSlices
): ComposedLivestoreModule<TSlices> => {
  // Compose at broad types inside the body — TS can't track that
  // `reduce`-spread of every slice's record produces the intersection of
  // their static shapes. The runtime is identical to
  // `{ ...slices[0].field, ...slices[1].field, ... }`, so the structural
  // invariant (the result carries every slice's keys) is the same one
  // the `composeLivestoreModules → merges …` cases in `index.test.ts`
  // exercise. Cast once at the return.
  const tables: SliceTables = slices.reduce<SliceTables>(
    (acc, slice) => ({ ...acc, ...slice.tables }),
    {}
  )
  const events: Record<string, EventDef.AnyWithoutFn> = slices.reduce<
    Record<string, EventDef.AnyWithoutFn>
  >((acc, slice) => ({ ...acc, ...slice.events }), {})
  const materializers: InputMaterializers = slices.reduce<InputMaterializers>(
    (acc, slice) => ({ ...acc, ...slice.materializers }),
    {}
  )

  const state = State.SQLite.makeState({ tables, materializers })
  const schema = makeSchema({ events, state })

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    tables,
    events,
    materializers,
    state,
    schema,
  } as unknown as ComposedLivestoreModule<TSlices>
}

export { composeLivestoreModules, defineSliceLivestore }
export type { ComposedLivestoreModule, InputTables, InputMaterializers, LivestoreModule }
export { makeLoopbackSyncBackend } from './loopback-sync-backend.ts'
export { subscribeUntil } from './subscribeUntil.ts'
export type { QueryableSubscribableStore } from './subscribeUntil.ts'
