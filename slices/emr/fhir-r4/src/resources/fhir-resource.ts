import { Schema } from 'effect'

import * as Binary from './binary/binary.ts'
import * as DiagnosticReport from './diagnostic-report/diagnostic-report.ts'
import * as DocumentReference from './document-reference/document-reference.ts'
import * as MedicationDispense from './medication-dispense/medication-dispense.ts'
import * as MedicationRequest from './medication-request/medication-request.ts'
import * as Observation from './observation/observation.ts'
import * as Patient from './patient/patient.ts'
import * as Practitioner from './practitioner/practitioner.ts'

/**
 * The Effect Schema union matching {@link FhirResource} — the eight domain
 * resource schemas as one discriminated-by-`resourceType` schema, for a
 * caller that needs to validate an unknown value as a supported resource
 * (the importer's inline resource editor, in particular).
 *
 * @remarks
 * Discrimination is by the `resourceType` literal each variant carries; a
 * decode preserves that literal so a downstream `switch (resource.resourceType)`
 * remains exhaustive. The union's `Type` is exported as {@link FhirResource}
 * so the type and schema stay in lockstep — adding or removing a variant here
 * is felt at every call site rather than drifting silently.
 */
const FhirResourceSchema = Schema.Union(
  Binary.Schema,
  Patient.Schema,
  Observation.Schema,
  MedicationRequest.Schema,
  MedicationDispense.Schema,
  DocumentReference.Schema,
  DiagnosticReport.Schema,
  Practitioner.Schema
)

/**
 * The closed union of every FHIR resource this slice can read/write — the
 * eight domain resources with a typed `Update` endpoint on
 * {@link FhirR4ResourcesHttpApiClient}. Discriminated by `resourceType`, so a
 * `switch` over it is exhaustive (see {@link upsertResource}).
 *
 * A collector that parses FHIR out of a remote produces values of this type;
 * previously each such collector re-declared its own `AnyResource` union next
 * to a copy of the write `switch`. Owning both here means a new
 * FHIR-targeting collector reuses one dispatch instead of restating it.
 *
 * Derived from {@link FhirResourceSchema} so the type and the runtime schema
 * stay in lockstep — a variant added or removed on one side is felt on the
 * other at compile time.
 */
type FhirResource = Schema.Schema.Type<typeof FhirResourceSchema>

export { FhirResourceSchema }
export type { FhirResource }
