import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'

import { rexallBeWellResponseKinds } from './response-kinds.ts'

/**
 * The Rexall Be Well source as one value — the package's primary export.
 * The archive importer reaches the `responseKinds` tuple through it by
 * reference. See `response-kinds.ts`.
 */
const rexallBeWellSource: SourceDescriptor.SourceDescriptor<DetachedResource.Type> =
  SourceDescriptor.make({
    name: 'rexall-be-well',
    display: {
      title: 'Rexall Be Well',
      description: 'Prescriptions from Rexall Be Well (letsbewell.ca).',
    },
    responseKinds: rexallBeWellResponseKinds,
  })

export { rexallBeWellSource }
