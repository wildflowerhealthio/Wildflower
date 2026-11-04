import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import type { HttpResponseKind } from '@wildflowerhealthio/http-extraction-fundamentals'

import { MedicationListResponseKind } from './response-kinds/medication-list-response-kind.ts'
import { ProfileResponseKind } from './response-kinds/profile-response-kind.ts'

/**
 * The two Rexall response kinds — Profile, MedicationList — each parsing
 * carebook's resources with carebook's own ids and references; their
 * `tryRecognize` mints {@link REXALL_CAREBOOK_SYSTEM_FAMILY}. A module-level
 * constant (stable by identity) the archive importer consumes by reference;
 * the two patterns are disjoint, so order is not load-bearing.
 */
const rexallBeWellResponseKinds: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = [
  ProfileResponseKind,
  MedicationListResponseKind,
]

export { rexallBeWellResponseKinds }
