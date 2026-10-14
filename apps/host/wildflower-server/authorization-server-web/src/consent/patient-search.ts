import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import type { HttpClientError } from '@effect/platform'
import { displayName } from '@wildflowerhealthio/fhir-r4/human-name-display'
import type { PatientOption } from '@wildflowerhealthio/scopes-react'
import { Effect, Schema } from 'effect'
import type { ParseResult } from 'effect'

/** How many patients one search lists: enough to pick from, few enough to read. */
const PATIENT_SEARCH_PAGE_SIZE = 20

/**
 * A `HumanName` as the search reads it: the fields its display name is read
 * from (fhir-r4's `displayName`). Narrowed from FHIR's `HumanName`, whose
 * schema would bring the whole datatype registry into the page.
 */
const PatientNameSchema = Schema.Struct({
  use: Schema.optional(Schema.String),
  given: Schema.optional(Schema.Array(Schema.String)),
  family: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  period: Schema.optional(Schema.Struct({ end: Schema.optional(Schema.String) })),
})

/**
 * A `Patient` as the search reads it: its `id`, which the approval binds, and
 * its names, which it is shown by. Narrowed from FHIR's `Patient`, whose other
 * fields the card never reads.
 */
const PatientSearchHitSchema = Schema.Struct({
  resourceType: Schema.Literal('Patient'),
  id: Schema.String,
  name: Schema.optionalWith(Schema.Array(PatientNameSchema), { default: () => [] }),
})

/**
 * Any other resource a searchset carries beside its matches, such as an
 * `OperationOutcome` about the search itself, or a `Patient` without an `id`,
 * which nothing could bind. Read only to be left out.
 */
const OtherSearchResourceSchema = Schema.Struct({ resourceType: Schema.String })

/** A FHIR searchset `Bundle` of patients, absent `entry` read as none. */
const PatientSearchBundleSchema = Schema.Struct({
  resourceType: Schema.Literal('Bundle'),
  entry: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        resource: Schema.Union(PatientSearchHitSchema, OtherSearchResourceSchema),
      })
    ),
    { default: () => [] }
  ),
})

type PatientSearchHit = Schema.Schema.Type<typeof PatientSearchHitSchema>

/** Whether a searchset `resource` is a patient the search found. */
const isPatientSearchHit = Schema.is(PatientSearchHitSchema)

/** The option the patient picker shows `patient` as: its display name, else its id. */
const patientOptionOf = (patient: PatientSearchHit): PatientOption => ({
  id: patient.id,
  displayName: displayName(patient.name) ?? patient.id,
})

/**
 * The server's patients whose name matches `name` (FHIR `GET /Patient?name=`),
 * as patient-picker options, on whatever session the `HttpClient` carries. An
 * empty `name` lists the server's first patients. The search reads every
 * patient the session's token may read, not only those the request names.
 */
const searchPatientsByName = (
  name: string
): Effect.Effect<
  readonly PatientOption[],
  HttpClientError.HttpClientError | ParseResult.ParseError,
  HttpClient.HttpClient
> => {
  const trimmedName = name.trim()
  const pageSize = { _count: String(PATIENT_SEARCH_PAGE_SIZE) }
  const request = HttpClientRequest.get('/Patient').pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.setUrlParams(
      trimmedName === '' ? pageSize : { ...pageSize, name: trimmedName }
    )
  )
  return Effect.flatMap(HttpClient.HttpClient, (client) =>
    HttpClient.filterStatusOk(client).execute(request)
  ).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(PatientSearchBundleSchema)),
    Effect.map((bundle) =>
      bundle.entry
        .map((entry) => entry.resource)
        .filter(isPatientSearchHit)
        .map(patientOptionOf)
    ),
    Effect.scoped
  )
}

export { searchPatientsByName }
