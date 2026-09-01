import { adoptUnderRecognizedRoot } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'

import { MedicationListResponseKind } from './response-kinds/medication-list-response-kind.ts'
import { ProfileResponseKind } from './response-kinds/profile-response-kind.ts'

/**
 * The two Rexall response kinds — Profile, MedicationList — each adopted so
 * its resources key under the root its own `tryRecognize` mints for the
 * response's URL.
 *
 * @remarks
 * The single definition both the live scraping plan
 * (`rexall-be-well-collector`) and the archive importer (`har-importer-core`)
 * consume, by reference. A module-level constant — the combinator takes no
 * source parameter, so the array is stable by identity, which is what the
 * config deep-equal suites and the live==archive parity rest on.
 *
 * The declared element type is the whole `FhirResource` union, which each
 * kind's narrower type satisfies by covariance — so no cast is needed, and
 * `adoptUnderRecognizedRoot` (whose per-kind guard demands the full union) can
 * map over the tuple as-is. `mustHaveQuery` on the MedicationList pattern
 * keeps the two kinds disjoint, so the order is not load-bearing.
 */
const unadopted: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = [
  ProfileResponseKind,
  MedicationListResponseKind,
]

const rexallBeWellResponseKinds = unadopted.map(adoptUnderRecognizedRoot)

export { rexallBeWellResponseKinds }
