import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'

import { fhirR4ResponseKinds } from './response-kinds.ts'

/**
 * The FHIR R4 source as one value — the package's whole public surface.
 *
 * @remarks
 * Consumers reach through this descriptor to the `responseKinds` tuple by
 * reference — the archive importer's pool (`har-importer-core`) flattens it.
 * See `response-kinds.ts` for the tuple's ordering.
 */
const fhirR4Source: SourceDescriptor.SourceDescriptor<DetachedResource.Type> =
  SourceDescriptor.make({
    name: 'fhir-r4',
    display: {
      title: 'FHIR R4 server',
      description:
        'Patient, Observation, DocumentReference and Binary reads from any server speaking FHIR R4 JSON.',
    },
    responseKinds: fhirR4ResponseKinds,
  })

export { fhirR4Source }
