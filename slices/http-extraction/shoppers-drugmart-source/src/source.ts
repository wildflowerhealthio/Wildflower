import type { FhirResource } from 'fhir-r4/resources'
import { SourceDescriptor } from 'http-extraction-fundamentals'

import { mergeShoppersResources } from './merge-resources.ts'
import { shoppersDrugMartResponseKinds } from './response-kinds.ts'

/**
 * The Shoppers Drug Mart source as one value — what a consumer extracts
 * with. Both the live plan and the archive importer reach the same
 * pre-adopted `responseKinds` tuple through it by reference. See
 * `response-kinds.ts`, and `merge-resources.ts` for how a dispense seen in
 * both prescription feeds becomes one.
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
  })

export { shoppersDrugMartSource }
