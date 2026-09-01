import type { FhirResource } from 'fhir-r4/resources'
import { SourceDescriptor } from 'http-extraction-fundamentals'

import { rexallBeWellResponseKinds } from './response-kinds.ts'

/**
 * The Rexall Be Well source as one value — the package's whole public surface.
 *
 * @remarks
 * Both consumers reach through this descriptor to the same pre-adopted
 * `responseKinds` tuple by reference: the live scraping plan
 * (`rexall-be-well-collector`) and the archive importer's pool
 * (`har-importer-core`), which is what keeps live and archive decode-and-key
 * behaviour reference-identical. See `response-kinds.ts` for the tuple's
 * adoption and ordering rationale.
 */
const rexallBeWellSource: SourceDescriptor.SourceDescriptor<FhirResource> = SourceDescriptor.make({
  name: 'rexall-be-well',
  display: {
    title: 'Rexall Be Well',
    description: 'Prescriptions from Rexall Be Well (letsbewell.ca).',
  },
  responseKinds: rexallBeWellResponseKinds,
})

export { rexallBeWellSource }
