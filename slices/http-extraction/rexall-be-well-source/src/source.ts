import type { FhirResource } from 'fhir-r4/resources'
import { SourceDescriptor } from 'http-extraction-fundamentals'

import { rexallBeWellResponseKinds } from './response-kinds.ts'

/**
 * The Rexall Be Well source as one value — the package's whole public surface.
 * Both the live plan and the archive importer reach the same pre-adopted
 * `responseKinds` tuple through it by reference. See `response-kinds.ts`.
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
