# store-core

FHIR R4 data types, schemas, queries, and resources backed by LiveStore.

## Entry points

- `store-core/schemas` — Effect Schemas for FHIR R4 data types (Address, CodeableConcept, Identifier, Reference, Extension, Narrative, etc.) under `datatypes/`, the structural bases (`BackboneElement`, `Resource`) under `base/`, plus the choice-element machinery and `Bundle`.
- `store-core/livestore` — LiveStore tables, events, materializers, and queries for the persisted resources (`Patient`, `Binary`, `Observation`).
- `store-core/contexts` — Effect Context tags and Layer factories (`LivestoreStore`, `makeLivestoreStoreLayer`).

## Layout

- `src/schemas/` — pure FHIR R4 Effect Schemas, no platform or storage assumptions.
- `src/livestore/` — per-resource modules that wrap the schemas in LiveStore tables and expose events/materializers/queries.
- `src/internal/domain-resource-persistence.ts` — generic factory that derives upsert/delete events, materializers, and `all$` / `getById$` / `search$` / `count$` queries from a table and row schema.
- `src/contexts/` — Effect Context tags shared across consumers.
