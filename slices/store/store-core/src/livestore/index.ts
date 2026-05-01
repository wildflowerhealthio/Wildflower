/**
 * LiveStore bindings for FHIR R4 domain resources.
 *
 * Each per-resource module (`patient.ts`, `binary.ts`, `observation.ts`)
 * owns its own composition: column-derived `RowSchema` /
 * `RowSchemaNullableId`, the livestore `table`, and the
 * `events` / `materializers` / `queries` produced by
 * `makeDomainResourcePersistence`. This file just re-exposes those
 * per-resource surfaces and stitches them together for app-level wiring.
 *
 * Exports:
 *  - `Patient` / `Binary` / `Observation` — per-resource namespaces; consumers
 *    access `Patient.RowSchema`, `Patient.events.upsert`, `Patient.queries.all$`,
 *    etc. through a single import.
 *  - `tables` — keyed by ResourceType; the raw livestore tableDefs.
 *  - `events` / `queries` — flat objects, spread-safe for an app-level
 *    livestore schema. Keys are prefixed by resource (`patientUpsert`,
 *    `binaryAll$`, ...).
 *  - `materializers` — composed materializer map, keyed by globally-unique
 *    event names so per-resource maps spread directly.
 *  - `domainResources` — `Record<ResourceType, { resourceType, table,
 *    RowSchema, RowSchemaNullableId, events, queries }>`, the structured
 *    surface for generic UI / wiring code.
 *  - `schema` / `state` / `SyncPayload` — the package-level livestore schema.
 *
 * @module
 */

import { State, makeSchema } from '@livestore/livestore'

import { Schema } from 'effect'
import * as Binary from './binary.ts'
import * as Observation from './observation.ts'
import * as Patient from './patient.ts'

// ---------------------------------------------------------------------------
// Flat, spread-safe composed bindings
// ---------------------------------------------------------------------------

const tables = {
  [Patient.resourceType]: Patient.table,
  [Binary.resourceType]: Binary.table,
  [Observation.resourceType]: Observation.table,
} as const

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
 * Each entry exposes the resource's table, row schemas, events (upsert /
 * deleteById), and queries (all$ / getById$).
 */
const domainResources: DomainResources = {
  [Patient.resourceType]: {
    resourceType: Patient.resourceType,
    table: Patient.table,
    RowSchema: Patient.RowSchema,
    RowSchemaNullableId: Patient.RowSchemaNullableId,
    events: Patient.events,
    queries: Patient.queries,
  },
  [Binary.resourceType]: {
    resourceType: Binary.resourceType,
    table: Binary.table,
    RowSchema: Binary.RowSchema,
    RowSchemaNullableId: Binary.RowSchemaNullableId,
    events: Binary.events,
    queries: Binary.queries,
  },
  [Observation.resourceType]: {
    resourceType: Observation.resourceType,
    table: Observation.table,
    RowSchema: Observation.RowSchema,
    RowSchemaNullableId: Observation.RowSchemaNullableId,
    events: Observation.events,
    queries: Observation.queries,
  },
} as const

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

const SyncPayload = Schema.Struct({ authToken: Schema.String })

export * as Patient from './patient.ts'
export * as Binary from './binary.ts'
export * as Observation from './observation.ts'
export * as ObservationComponent from './observation-component.ts'
export * as ObservationReferenceRange from './observation-reference-range.ts'
export * as PatientCommunication from './patient-communication.ts'
export * as PatientContact from './patient-contact.ts'
export * as PatientLink from './patient-link.ts'

export type { ExtensionType, ExtensionEncoded } from '../schemas/datatypes/extension.ts'
export { schema, state, tables, events, queries, materializers, domainResources, SyncPayload }
