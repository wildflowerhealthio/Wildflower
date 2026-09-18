/**
 * Stamping `meta.source` onto FHIR resources: the single-resource
 * {@link stamp} and the batch {@link stampDecoded} that walks every resource
 * in a decoded file's sections.
 *
 * @remarks
 * Both take a `SourceFile.Reference` rather than a bare `string` — the slice's
 * one currency for "which source file", so the only place it could be laundered
 * back into an unconstrained string is closed. That vocabulary is context-free,
 * so naming it here costs nothing: the codec it used to sit beside is a
 * separate module.
 *
 * @packageDocumentation
 */

import type { Meta } from 'fhir-r4/data-types'

import type * as DecodedFile from './decoded-file.ts'
import type * as SourceFile from './source-file.ts'

interface Sourceable {
  readonly meta: typeof Meta.Schema.Type | null
}

const stamp = <TResource extends Sourceable>(
  resource: TResource,
  source: SourceFile.Reference
): TResource => ({
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

const stampDecoded = (
  decoded: DecodedFile.DecodedFile,
  source: SourceFile.Reference
): DecodedFile.DecodedFile => ({
  ...decoded,
  sections: decoded.sections.map((section) => ({
    ...section,
    resources: section.resources.map((entry): DecodedFile.Resource => ({
      ...entry,
      resource: stamp(entry.resource, source),
    })),
  })),
})

export { type Sourceable, stamp, stampDecoded }
