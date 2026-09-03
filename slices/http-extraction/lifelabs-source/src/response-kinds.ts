import { adoptUnderRecognizedRoot } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'

import { AnalyticSummaryResponseKind } from './response-kinds/analytic-summary-response-kind.ts'

/**
 * The LifeLabs response kinds — just `AnalyticSummary` for now — adopted so
 * their resources key under the root each kind's own `tryRecognize` mints. A
 * module-level constant (stable by identity) both the live plan and the archive
 * importer consume by reference.
 */
const unadopted: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = [
  AnalyticSummaryResponseKind,
]

const lifeLabsResponseKinds = unadopted.map(adoptUnderRecognizedRoot)

export { lifeLabsResponseKinds }
