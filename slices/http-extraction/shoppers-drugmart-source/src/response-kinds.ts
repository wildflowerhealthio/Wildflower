import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { HttpResponseKind } from '@wildflowerhealthio/http-extraction-fundamentals'

import { CustomerResponseKind } from './response-kinds/customer-response-kind.ts'
import { PrescriptionHistoryResponseKind } from './response-kinds/prescription-history-response-kind.ts'
import { PrescriptionResponseKind } from './response-kinds/prescription-response-kind.ts'

/**
 * The three Shoppers Drug Mart response kinds — Customer, Prescription,
 * PrescriptionHistory — each synthesizing detached resources keyed in the
 * portal's own identifier systems (`ShoppersIdentifierSystem`), naming one
 * another by logical reference. A module-level constant (stable by
 * identity) the archive importer consumes by reference; the three recognizers
 * are disjoint by construction (different path segments), so order is not
 * load-bearing.
 */
const shoppersDrugMartResponseKinds: readonly HttpResponseKind.HttpResponseKind<DetachedResource.Type>[] =
  [CustomerResponseKind, PrescriptionResponseKind, PrescriptionHistoryResponseKind]

export { shoppersDrugMartResponseKinds }
