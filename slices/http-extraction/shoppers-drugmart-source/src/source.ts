import type { FhirResource } from 'fhir-r4/resources'
import { SourceDescriptor } from 'http-extraction-fundamentals'

import { shoppersDrugMartResponseKinds } from './response-kinds.ts'

/**
 * The Shoppers Drug Mart source as one value — the package's whole public
 * surface.
 *
 * @remarks
 * Both consumers reach through this descriptor to the same pre-adopted
 * `responseKinds` tuple by reference: the live scraping plan
 * (`shoppers-drugmart-collector`) and the archive importer's pool
 * (`har-importer-core`), which is what keeps live and archive decode-and-key
 * behaviour reference-identical. See `response-kinds.ts` for the tuple's
 * adoption and ordering rationale.
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
