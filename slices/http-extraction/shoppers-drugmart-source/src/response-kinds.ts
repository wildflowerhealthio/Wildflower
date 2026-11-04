import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import type { HttpResponseKind } from '@wildflowerhealthio/http-extraction-fundamentals'

import { CustomerResponseKind } from './response-kinds/customer-response-kind.ts'
import { PrescriptionHistoryResponseKind } from './response-kinds/prescription-history-response-kind.ts'
import { PrescriptionResponseKind } from './response-kinds/prescription-response-kind.ts'

/**
 * The three Shoppers Drug Mart response kinds — Customer, Prescription,
 * PrescriptionHistory — each synthesizing resources with the portal's own ids
 * and references; their `tryRecognize` mints `SHOPPERS_DRUGMART_SYSTEM_FAMILY`,
 * the namespace of each type's ids. A module-level constant (stable by
 * identity) the archive importer consumes by reference; the three recognizers
 * are disjoint by construction (different path segments), so order is not
 * load-bearing.
 */
const shoppersDrugMartResponseKinds: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = [
  CustomerResponseKind,
  PrescriptionResponseKind,
  PrescriptionHistoryResponseKind,
]

export { shoppersDrugMartResponseKinds }
