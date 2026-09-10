import type { FhirResource } from 'fhir-r4/resources'
import { SourceDescriptor } from 'http-extraction-fundamentals'

import { lifeLabsPdfResponseKinds } from './response-kind.ts'

/**
 * The LifeLabs PDF source as one value — the descriptor's `sources` entry, so
 * the review menu labels the import by source and the recognizer routes
 * against `SourceDescriptor.poolOf([lifeLabsPdfSource])`.
 */
const lifeLabsPdfSource: SourceDescriptor.SourceDescriptor<FhirResource> = SourceDescriptor.make({
  name: 'lifelabs-pdf',
  display: {
    title: 'LifeLabs report (PDF)',
    description:
      'Lab results from a LifeLabs patient report PDF, extracted to positioned text and synthesized to FHIR R4.',
  },
  responseKinds: lifeLabsPdfResponseKinds,
})

export { lifeLabsPdfSource }
