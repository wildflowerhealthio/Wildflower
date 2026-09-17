/**
 * Stamping `meta.source` onto FHIR resources: the single-resource
 * {@link stamp} and the batch {@link stampDecoded} that walks every resource
 * in a decoded file's sections.
 *
 * @packageDocumentation
 */

import type { Meta } from 'fhir-r4/data-types'

import type * as DecodedFile from './decoded-file.ts'

interface Sourceable {
  readonly meta: typeof Meta.Schema.Type | null
}

const stamp = <TResource extends Sourceable>(resource: TResource, source: string): TResource => ({
  ...resource,
  meta: {
    lastUpdated: null,
    profile: [],
    security: [],
    tag: [],
    versionId: null,
    ...resource.meta,
    source,
  },
})

const stampDecoded = <TParsed extends Sourceable>(
  decoded: DecodedFile.DecodedFile<TParsed>,
  source: string
): DecodedFile.DecodedFile<TParsed> => ({
  ...decoded,
  sections: decoded.sections.map((section) => ({
    ...section,
    resources: section.resources.map((entry): DecodedFile.Resource<TParsed> => ({
      ...entry,
      resource: stamp(entry.resource, source),
    })),
  })),
})

export { type Sourceable, stamp, stampDecoded }
