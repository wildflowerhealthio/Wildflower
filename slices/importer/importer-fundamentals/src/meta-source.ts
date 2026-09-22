/**
 * Stamping `meta.source` onto FHIR resources: the typed {@link Reference} a
 * stamp names, the single-resource {@link stamp}, and the batch
 * {@link stampDecoded} that walks every resource in a decoded file's sections.
 *
 * @remarks
 * Both stamps take a {@link Reference} rather than a bare `string` — the
 * slice's one currency for "which archive" — so the only place it could be
 * laundered back into an unconstrained string is closed. The vocabulary lives
 * here, beside its one consumer, which keeps this module free of the codec and
 * of any schema import.
 *
 * @packageDocumentation
 */

import type { Meta } from 'fhir-r4/data-types'

import type * as DecodedFile from './decoded-file.ts'

const REFERENCE_PREFIX = 'DocumentReference/'

/**
 * A typed FHIR reference to an archive's `DocumentReference`, carrying the
 * invariant that the string is `DocumentReference/<id>` at the type level.
 */
type Reference = `DocumentReference/${string}`

/** The reference a resource stamped with this archive names. */
const makeReference = (id: string): Reference => `${REFERENCE_PREFIX}${id}`

interface Sourceable {
  readonly meta: typeof Meta.Schema.Type | null
}

const stamp = <TResource extends Sourceable>(
  resource: TResource,
  source: Reference
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
  source: Reference
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

export { makeReference, stamp, stampDecoded }
export type { Reference, Sourceable }
