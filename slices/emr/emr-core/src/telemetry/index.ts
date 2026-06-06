/**
 * Central catalog of LiveStore span *labels* for EMR domain resources.
 *
 * These strings are passed to LiveStore as the `label` on `queryDb(...)`
 * definitions and as the `label` option on `store.commit(...)`. LiveStore
 * uses them to name the query/commit spans it emits (and to label entries in
 * its devtools), so keeping them in one place keeps those names coherent.
 *
 * This catalog deliberately covers only the LiveStore layer. The OpenTelemetry
 * spans for the FHIR HTTP API (search/read/write/$everything) live in
 * `fhir-r4/telemetry` — the two are split along the package boundary.
 *
 * Labels are parameterised by FHIR `resourceType` (`Patient` / `Observation` /
 * `Binary`), so each entry is a factory. Shape: `emr.<ResourceType>.<layer>.<op>`,
 * lowercase/`snake_case` operations under a stable `emr.*` namespace, with the
 * resource type kept verbatim so it reads as the canonical FHIR identifier.
 */

/** Labels for the standard read queries exposed by the persistence layer. */
const Query = {
  /** Whole-table scan (`all$`). */
  All: (resourceType: string): string => `emr.${resourceType}.query.all`,
  /** Single-row lookup by id (`getById$`). */
  GetById: (resourceType: string): string => `emr.${resourceType}.query.get_by_id`,
  /** Filtered, paged search (`search$`). */
  Search: (resourceType: string): string => `emr.${resourceType}.query.search`,
  /** Row count, optionally filtered (`count$`). */
  Count: (resourceType: string): string => `emr.${resourceType}.query.count`,
} as const

/** Labels for the commits raised by the persistence layer's events. */
const Commit = {
  /** Create-or-replace of a single resource (`v1.<ResourceType>Upserted`). */
  Upsert: (resourceType: string): string => `emr.${resourceType}.commit.upsert`,
} as const

export { Commit, Query }
