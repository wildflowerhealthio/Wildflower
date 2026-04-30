/**
 * LiveStore bindings for FHIR R4 domain resources.
 *
 * Each per-resource module (`patient.ts`, `binary.ts`, `observation.ts`)
 * exports its resource name, column-derived `RowSchema` / `RowSchemaOptionalId`
 * Structs, and a columns-based livestore `table`. This composer passes each
 * `table` plus the explicit `RowSchema` through `makeDomainResourcePersistence`
 * to derive events, materializers, and queries.
 *
 * Exports:
 *  - `Patient` / `Binary` / `Observation` — per-resource namespaces; consumers
 *    access `Patient.RowSchema`, `Patient.RowSchemaOptionalId`, `Patient.table`,
 *    etc. through a single import.
 *  - `tables` — keyed by ResourceType; the raw livestore tableDefs.
 *  - `events` / `queries` — flat objects, spread-safe for an app-level
 *    livestore schema.
 *  - `materializers` — composed materializer map, likewise spread-safe.
 *  - `domainResources` — `Record<ResourceType, { resourceType, table,
 *    RowSchema, RowSchemaOptionalId, events, queries }>`, the structured
 *    surface for generic UI / wiring code.
 *  - `schema` / `state` / `SyncPayload` — the package-level livestore schema.
 *
 * @module
 */

import { State, makeSchema } from '@livestore/livestore'

import { Schema } from 'effect'
import { makeDomainResourcePersistence } from '../internal/domain-resource-persistence.ts'
import * as Binary from './binary.ts'
import * as Observation from './observation.ts'
import * as Patient from './patient.ts'

// ---------------------------------------------------------------------------
// Per-resource composition
// ---------------------------------------------------------------------------

const patient = (() => {
  const { events, materializers, queries } = makeDomainResourcePersistence({
    table: Patient.table,
    rowSchema: Patient.RowSchema,
  })
  return {
    resourceType: Patient.resourceType,
    table: Patient.table,
    RowSchema: Patient.RowSchema,
    RowSchemaOptionalId: Patient.RowSchemaOptionalId,
    events,
    materializers,
    queries,
  } as const
})()

const binary = (() => {
  const { events, materializers, queries } = makeDomainResourcePersistence({
    table: Binary.table,
    rowSchema: Binary.RowSchema,
  })
  return {
    resourceType: Binary.resourceType,
    table: Binary.table,
    RowSchema: Binary.RowSchema,
    RowSchemaOptionalId: Binary.RowSchemaOptionalId,
    events,
    materializers,
    queries,
  } as const
})()

const observation = (() => {
  const { events, materializers, queries } = makeDomainResourcePersistence({
    table: Observation.table,
    rowSchema: Observation.RowSchema,
  })
  return {
    resourceType: Observation.resourceType,
    table: Observation.table,
    RowSchema: Observation.RowSchema,
    RowSchemaOptionalId: Observation.RowSchemaOptionalId,
    events,
    materializers,
    queries,
  } as const
})()

// ---------------------------------------------------------------------------
// Flat, spread-safe composed bindings
// ---------------------------------------------------------------------------

const tables = {
  [patient.resourceType]: patient.table,
  [binary.resourceType]: binary.table,
  [observation.resourceType]: observation.table,
} as const

const events = {
  patientUpsert: patient.events.upsert,
  patientDeleteById: patient.events.deleteById,
  binaryUpsert: binary.events.upsert,
  binaryDeleteById: binary.events.deleteById,
  observationUpsert: observation.events.upsert,
  observationDeleteById: observation.events.deleteById,
} as const

const queries = {
  patientAll$: patient.queries.all$,
  patientGetById$: patient.queries.getById$,
  binaryAll$: binary.queries.all$,
  binaryGetById$: binary.queries.getById$,
  observationAll$: observation.queries.all$,
  observationGetById$: observation.queries.getById$,
} as const

// Materializers are keyed by globally-unique event `.name` strings, so
// spreading the per-resource materializer outputs composes them directly.
const materializers = {
  ...patient.materializers,
  ...binary.materializers,
  ...observation.materializers,
} as const

// ---------------------------------------------------------------------------
// Structured per-resource surface
// ---------------------------------------------------------------------------

type DomainResourceBinding<R extends typeof patient | typeof binary | typeof observation> = Pick<
  R,
  'resourceType' | 'table' | 'RowSchema' | 'RowSchemaOptionalId' | 'events' | 'queries'
>

type DomainResources = {
  readonly [K in typeof Patient.resourceType]: DomainResourceBinding<typeof patient>
} & {
  readonly [K in typeof Binary.resourceType]: DomainResourceBinding<typeof binary>
} & {
  readonly [K in typeof Observation.resourceType]: DomainResourceBinding<typeof observation>
}

/**
 * Structured per-resource bindings, keyed by ResourceType. Intended for
 * generic UI / wiring code that iterates over the supported resource set.
 * Each entry exposes the resource's table, row schemas, events (upsert /
 * deleteById), and queries (all$ / getById$).
 */
const domainResources: DomainResources = {
  [patient.resourceType]: {
    resourceType: patient.resourceType,
    table: patient.table,
    RowSchema: patient.RowSchema,
    RowSchemaOptionalId: patient.RowSchemaOptionalId,
    events: patient.events,
    queries: patient.queries,
  },
  [binary.resourceType]: {
    resourceType: binary.resourceType,
    table: binary.table,
    RowSchema: binary.RowSchema,
    RowSchemaOptionalId: binary.RowSchemaOptionalId,
    events: binary.events,
    queries: binary.queries,
  },
  [observation.resourceType]: {
    resourceType: observation.resourceType,
    table: observation.table,
    RowSchema: observation.RowSchema,
    RowSchemaOptionalId: observation.RowSchemaOptionalId,
    events: observation.events,
    queries: observation.queries,
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

export type { ExtensionType, ExtensionEncoded } from '../schemas/special-purpose/extension.ts'
export { schema, state, tables, events, queries, materializers, domainResources, SyncPayload }
