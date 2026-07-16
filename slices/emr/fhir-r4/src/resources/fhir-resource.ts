import type { Binary } from './binary/index.ts'
import type { MedicationDispense } from './medication-dispense/index.ts'
import type { MedicationRequest } from './medication-request/index.ts'
import type { Observation } from './observation/index.ts'
import type { Patient } from './patient/index.ts'

/**
 * The closed union of every FHIR resource this slice can read/write — the
 * five domain resources with a typed `Update` endpoint on
 * {@link FhirR4ResourcesHttpApiClient}. Discriminated by `resourceType`, so a
 * `switch` over it is exhaustive (see {@link upsertResource}).
 *
 * A collector that parses FHIR out of a remote produces values of this type;
 * previously each such collector re-declared its own `AnyResource` union next
 * to a copy of the write `switch`. Owning both here means a new
 * FHIR-targeting collector reuses one dispatch instead of restating it.
 */
type FhirResource =
  | typeof Binary.Schema.Type
  | typeof Patient.Schema.Type
  | typeof Observation.Schema.Type
  | typeof MedicationRequest.Schema.Type
  | typeof MedicationDispense.Schema.Type

export type { FhirResource }
