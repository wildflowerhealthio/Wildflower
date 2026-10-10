import { Schema } from 'effect'

/** A health status: `pass` (healthy), `warn` (healthy but degraded) or `fail` (unhealthy). */
const StatusSchema = Schema.Literal('pass', 'warn', 'fail')

/** A decoded {@link StatusSchema}. */
type Status = typeof StatusSchema.Type

/**
 * What kind of component a check measures: a part of the server, a store it
 * reads and writes, or the server as a whole.
 */
const ComponentTypeSchema = Schema.Literal('component', 'datastore', 'system')

/** One check: the status one measurement of a component had at `time`. */
const CheckSchema = Schema.Struct({
  componentType: ComponentTypeSchema,
  status: StatusSchema,
  time: Schema.DateTimeUtc,
})

/** A decoded {@link CheckSchema}. */
type Check = typeof CheckSchema.Type

/**
 * A server's `/health` body: the `draft-inadarei-api-health-check-06` report
 * `shared_structures_rust::health_check::HealthReport` serves, its overall
 * status and the checks behind it, keyed `"componentName[:measurementName]"`
 * (`server`, `connectivity`, `fhir-r4`, ...).
 *
 * @remarks
 * The server leaves `checks` out when it has none, which decodes as no
 * checks. The draft's other members are never served, and are ignored.
 */
const HealthReportSchema = Schema.Struct({
  status: StatusSchema,
  checks: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Array(CheckSchema) }),
    { default: () => ({}) }
  ),
})

/** A decoded {@link HealthReportSchema}. */
type Type = typeof HealthReportSchema.Type

export { CheckSchema, ComponentTypeSchema, HealthReportSchema as Schema, StatusSchema }
export type { Check, Status, Type }
