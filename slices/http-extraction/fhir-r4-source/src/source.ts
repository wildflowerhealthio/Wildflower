import type { FhirResource } from 'fhir-r4/resources'
import { SourceDescriptor } from 'http-extraction-fundamentals'

import { fhirR4ResponseKinds } from './response-kinds.ts'

/**
 * The FHIR R4 source as one value — the package's whole public surface.
 *
 * @remarks
 * Both consumers reach through this descriptor to the same pre-adopted
 * `responseKinds` tuple by reference: the live scraping plan
 * (`fhir-r4-client-collector`) and the archive importer's pool
 * (`har-importer-core`), which is what keeps live and archive decode-and-key
 * behaviour reference-identical. See `response-kinds.ts` for the tuple's
 * adoption and ordering rationale.
 */
const fhirR4Source: SourceDescriptor.SourceDescriptor<FhirResource> = SourceDescriptor.make({
  name: 'fhir-r4',
  display: {
    title: 'FHIR R4 server',
    description: 'Patient and Observation reads from any server speaking FHIR R4 JSON.',
  },
  responseKinds: fhirR4ResponseKinds,
})

export { fhirR4Source }
