import { adoptUnderRecognizedRoot } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'

import { CustomerResponseKind } from './response-kinds/customer-response-kind.ts'
import { PrescriptionHistoryResponseKind } from './response-kinds/prescription-history-response-kind.ts'
import { PrescriptionResponseKind } from './response-kinds/prescription-response-kind.ts'

/**
 * The three Shoppers Drug Mart response kinds — Customer, Prescription,
 * PrescriptionHistory — each adopted so its resources key under the root its own
 * `tryRecognize` mints. A module-level constant (stable by identity) both the
 * live plan and the archive importer consume by reference; the three
 * recognizers are disjoint by construction (different path segments), so order
 * is not load-bearing.
 */
const unadopted: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = [
  CustomerResponseKind,
  PrescriptionResponseKind,
  PrescriptionHistoryResponseKind,
]

const shoppersDrugMartResponseKinds = unadopted.map(adoptUnderRecognizedRoot)

export { shoppersDrugMartResponseKinds }
