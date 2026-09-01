import { adoptUnderRecognizedRoot } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'

import { CustomerResponseKind } from './response-kinds/customer-response-kind.ts'
import { PrescriptionHistoryResponseKind } from './response-kinds/prescription-history-response-kind.ts'
import { PrescriptionResponseKind } from './response-kinds/prescription-response-kind.ts'

/**
 * The three Shoppers Drug Mart response kinds — Customer, Prescription,
 * PrescriptionHistory — each adopted so its resources key under the root its
 * own `tryRecognize` mints for the response's URL.
 *
 * @remarks
 * The single definition both the live scraping plan
 * (`shoppers-drugmart-collector`) and the archive importer (`har-importer-core`)
 * consume, by reference. A module-level constant — the combinator takes no
 * source parameter, so the array is stable by identity, which is what the
 * config deep-equal suites and the live==archive parity rest on.
 *
 * The declared element type is the whole `FhirResource` union, which each
 * kind's narrower type satisfies by covariance — so no cast is needed, and
 * `adoptUnderRecognizedRoot` (whose per-kind guard demands the full union) can
 * map over the tuple as-is. The three recognizers are disjoint by construction
 * (different path segments), so the order is not load-bearing; it only fixes
 * the sequence both surfaces route by.
 */
const unadopted: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = [
  CustomerResponseKind,
  PrescriptionResponseKind,
  PrescriptionHistoryResponseKind,
]

const shoppersDrugMartResponseKinds = unadopted.map(adoptUnderRecognizedRoot)

export { shoppersDrugMartResponseKinds }
