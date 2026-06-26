/**
 * LiveStore bindings for FHIR R4 domain resources.
 *
 * Each per-resource module (`patient.ts`, `binary.ts`, `observation.ts`)
 * owns its own composition: column-derived `RowSchema` /
 * `RowSchemaNullableId`, the livestore `table`, and the
 * `events` / `materializers` / `queries` produced by
 * `makeDomainResourcePersistence`. Sub-resources nest under their parent
 * (`Patient.Contact`, `Observation.Component`, …). This file just re-exposes
 * those per-resource surfaces and stitches them together for app-level
 * wiring.
 *
 * Exports:
 *  - `Patient` / `Binary` / `Observation` — per-resource namespaces; consumers
 *    access `Patient.RowSchema`, `Patient.events.upsert`, `Patient.queries.all$`,
 *    `Patient.Contact.Schema`, etc. through a single import.
 *  - `tables` — keyed by ResourceType; the raw livestore tableDefs.
 *  - `events` / `queries` — flat objects, spread-safe for an app-level
 *    livestore schema. Keys are prefixed by resource (`patientUpsert`,
 *    `binaryAll$`, ...).
 *  - `materializers` — composed materializer map, keyed by globally-unique
 *    event names so per-resource maps spread directly.
 *  - `domainResources` — `Record<ResourceType, DomainResourceBinding>`, the
 *    structured surface for generic UI / wiring code; entries are the
 *    per-resource namespaces themselves narrowed to the binding shape.
 *  - `schema` / `state` / `SyncPayload` — the package-level livestore schema.
 *
 */

import type { Queryable } from '@livestore/livestore'
import { Schema } from 'effect'
import { defineSliceLivestore } from 'shared-structures-core/livestore'

import * as Binary from './binary.ts'
import * as Observation from './observation.ts'
import * as Patient from './patient.ts'

// ---------------------------------------------------------------------------
// Flat, spread-safe composed bindings
// ---------------------------------------------------------------------------

const tables: {
  readonly [Patient.resourceType]: Patient.Table
  readonly [Binary.resourceType]: Binary.Table
  readonly [Observation.resourceType]: Observation.Table
} = {
  [Patient.resourceType]: Patient.table,
  [Binary.resourceType]: Binary.table,
  [Observation.resourceType]: Observation.table,
}

const events = {
  patientUpsert: Patient.events.upsert,
  patientDeleteById: Patient.events.deleteById,
  binaryUpsert: Binary.events.upsert,
  binaryDeleteById: Binary.events.deleteById,
  observationUpsert: Observation.events.upsert,
  observationDeleteById: Observation.events.deleteById,
} as const

const queries = {
  patientAll$: Patient.queries.all$,
  patientGetById$: Patient.queries.getById$,
  binaryAll$: Binary.queries.all$,
  binaryGetById$: Binary.queries.getById$,
  observationAll$: Observation.queries.all$,
  observationGetById$: Observation.queries.getById$,
} as const

// Materializers are keyed by globally-unique event `.name` strings, so
// spreading the per-resource materializer outputs composes them directly.
const materializers = {
  ...Patient.materializers,
  ...Binary.materializers,
  ...Observation.materializers,
} as const

// ---------------------------------------------------------------------------
// Structured per-resource surface
// ---------------------------------------------------------------------------

type DomainResourceBinding<R extends typeof Patient | typeof Binary | typeof Observation> = {
  readonly resourceType: R['resourceType']
  readonly table: R['table']
  readonly RowSchema: R['RowSchema']
  readonly RowSchemaNullableId: R['RowSchemaNullableId']
  readonly events: R['events']
  readonly queries: R['queries']
}

type DomainResources = {
  readonly [K in typeof Patient.resourceType]: DomainResourceBinding<typeof Patient>
} & {
  readonly [K in typeof Binary.resourceType]: DomainResourceBinding<typeof Binary>
} & {
  readonly [K in typeof Observation.resourceType]: DomainResourceBinding<typeof Observation>
}

/**
 * Structured per-resource bindings, keyed by ResourceType. Intended for
 * generic UI / wiring code that iterates over the supported resource set.
 * Each entry is the resource's namespace itself, narrowed by the
 * `DomainResources` annotation to the `DomainResourceBinding` surface
 * (`resourceType`, `table`, `RowSchema`, `RowSchemaNullableId`, `events`,
 * `queries`). The annotation also serves as a compile-time check that each
 * per-resource module exports the full binding shape.
 */
const domainResources: DomainResources = {
  [Patient.resourceType]: Patient,
  [Binary.resourceType]: Binary,
  [Observation.resourceType]: Observation,
} as const

const { schema, state, StoreTag, makeLayerFactory } = defineSliceLivestore({
  name: 'EmrStore',
  tables,
  events,
  materializers,
})

class EmrStore extends StoreTag<EmrStore>() {
  static readonly layerFrom = makeLayerFactory(EmrStore)
}

const SyncPayload = Schema.Struct({ authToken: Schema.String })

/**
 * Minimal duck-typed shape for issuing read queries. Any `Store<TSchema>`
 * satisfies this regardless of which composed slice schema it was built
 * from, so the warmup function can be called from apps that compose the
 * EMR slice into a larger livestore schema without
 * the call site having to widen schema types.
 */
type QueryRunner = {
  readonly query: <TResult>(query: Queryable<TResult>) => TResult
}

/**
 * Touch the Patient table at boot so SQLite's per-table page cache, the
 * statement cache, and the tables-used cache are populated before the
 * first user-facing query.
 *
 * Idempotent. Safe to call repeatedly; second call hits the result
 * cache and returns immediately.
 *
 * @typeParam TSearchResult - Row type produced by the resource's `search$`
 *   query; inferred from the passed `Resource` so the call site never needs
 *   to annotate it. The result is discarded, but keeping it generic lets a
 *   concrete `Queryable<Row>` match without widening to `any` (`Queryable`
 *   is invariant, so `unknown` would reject a concrete row type).
 * @param store - The EMR LiveStore to issue warmup queries against.
 *
 */
const warmupTable = <TSearchResult>(
  store: QueryRunner,
  options: {
    readonly Resource: {
      readonly queries: {
        readonly count$: (params: object) => Queryable<number>
        readonly search$: (params: { readonly limit: number }) => Queryable<TSearchResult>
      }
    }
    readonly searchLimit?: number
  }
): void => {
  const Resource = options.Resource
  const searchLimit = options.searchLimit ?? 50
  store.query(Resource.queries.count$({}))
  store.query(Resource.queries.search$({ limit: searchLimit }))
}

export * as Patient from './patient.ts'
export * as Binary from './binary.ts'
export * as Observation from './observation.ts'

export type { ExtensionType, ExtensionEncoded } from '../schemas/datatypes/extension.ts'
export {
  schema,
  state,
  tables,
  events,
  queries,
  materializers,
  domainResources,
  SyncPayload,
  EmrStore,
  warmupTable,
}
