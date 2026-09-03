import type { FhirResource } from 'fhir-r4/resources'
import { SourceDescriptor } from 'http-extraction-fundamentals'

import { lifeLabsResponseKinds } from './response-kinds.ts'

/**
 * The LifeLabs source as one value — the package's whole public surface. Both
 * the live plan and the archive importer reach the same pre-adopted
 * `responseKinds` tuple through it by reference. See `response-kinds.ts`.
 */
const lifeLabsSource: SourceDescriptor.SourceDescriptor<FhirResource> = SourceDescriptor.make({
  name: 'lifelabs',
  display: {
    title: 'LifeLabs',
    description:
      'Lab results from the LifeLabs MyCareCompass portal (bespoke JSON, synthesized to FHIR R4).',
  },
  responseKinds: lifeLabsResponseKinds,
})

export { lifeLabsSource }
