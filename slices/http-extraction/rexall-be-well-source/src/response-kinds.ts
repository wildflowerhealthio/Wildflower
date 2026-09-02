import { adoptUnderRecognizedRoot } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'

import { MedicationListResponseKind } from './response-kinds/medication-list-response-kind.ts'
import { ProfileResponseKind } from './response-kinds/profile-response-kind.ts'

/**
 * The two Rexall response kinds — Profile, MedicationList — each adopted so its
 * resources key under the root its own `tryRecognize` mints. A module-level
 * constant (stable by identity) both the live plan and the archive importer
 * consume by reference; the two patterns are disjoint, so order is not
 * load-bearing.
 */
const unadopted: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = [
  ProfileResponseKind,
  MedicationListResponseKind,
]

const rexallBeWellResponseKinds = unadopted.map(adoptUnderRecognizedRoot)

export { rexallBeWellResponseKinds }
