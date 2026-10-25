import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'

import { completeShoppersExtraction } from './history-fill-subjects.ts'
import { mergeShoppersResources } from './merge-resources.ts'
import { shoppersDrugMartResponseKinds } from './response-kinds.ts'

/**
 * The Shoppers Drug Mart source as one value — what a consumer extracts
 * with. The archive importer reaches the pre-adopted `responseKinds` tuple
 * through it by reference. See `response-kinds.ts`, `merge-resources.ts` for
 * how a dispense seen in both prescription feeds becomes one, and
 * `history-fill-subjects.ts` for how a history fill is filed on its person.
 */
const shoppersDrugMartSource: SourceDescriptor.SourceDescriptor<FhirResource> =
  SourceDescriptor.make({
    name: 'shoppers-drugmart',
    display: {
      title: 'Shoppers Drug Mart',
      description:
        'Prescriptions from the Shoppers Drug Mart mypharmacy portal (bespoke JSON, synthesized to FHIR R4).',
    },
    responseKinds: shoppersDrugMartResponseKinds,
    mergeResources: mergeShoppersResources,
    completeFromExtraction: completeShoppersExtraction,
  })

export { shoppersDrugMartSource }
