import type { FhirResource } from 'fhir-r4/resources'
import { SourceDescriptor } from 'http-extraction-fundamentals'

import { shoppersDrugMartResponseKinds } from './response-kinds.ts'

/**
 * The Shoppers Drug Mart source as one value — the package's whole public
 * surface. Both the live plan and the archive importer reach the same
 * pre-adopted `responseKinds` tuple through it by reference. See
 * `response-kinds.ts`.
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
  })

export { shoppersDrugMartSource }
