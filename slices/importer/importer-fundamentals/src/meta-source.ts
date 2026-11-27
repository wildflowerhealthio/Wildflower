/**
 * Stamping `meta.source` onto FHIR resources and reading it back: the typed
 * {@link Reference} a stamp names, the single-resource {@link stamp},
 * {@link stampAdopted} that walks every resource in an adopted file set's
 * sections, and {@link sourceOf}, the source file a resource names.
 *
 * @remarks
 * Both stamps take a {@link Reference} rather than a bare `string` — the
 * slice's one currency for "which source file" — so the only place it could be
 * laundered back into an unconstrained string is closed. The vocabulary lives
 * here, beside its one consumer, which keeps this module free of the codec and
 * of any schema import.
 *
 * @packageDocumentation
 */

import type { Meta } from '@wildflowerhealthio/fhir-r4/data-types'
import { Option, pipe } from 'effect'

import type * as AdoptedFileSet from './adopted-file-set.ts'
import type * as ReviewRow from './review-row.ts'
import * as SectionedList from './sectioned-list.ts'

const REFERENCE_PREFIX = 'DocumentReference/'

/**
 * A typed FHIR reference to a source file's `DocumentReference`, carrying the
 * invariant that the string is `DocumentReference/<id>` at the type level.
 */
type Reference = `DocumentReference/${string}`

/** The reference a resource stamped with this source file names. */
const makeReference = (id: string): Reference => `${REFERENCE_PREFIX}${id}`

/** Whether `literal` is a {@link Reference}: a literal reference to a `DocumentReference`. */
const isReference = (literal: string): literal is Reference => literal.startsWith(REFERENCE_PREFIX)

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

const stampAdopted = <TRow extends ReviewRow.Type>(
  adopted: AdoptedFileSet.Type<TRow>,
  source: Reference
): AdoptedFileSet.Type<TRow> => ({
  ...adopted,
  sectionedList: SectionedList.map(adopted.sectionedList, (row) => ({
    ...row,
    resource: stamp(row.resource, source),
  })),
})

/** The source file `resource`'s `meta.source` names; `None` when it names none. */
const sourceOf = (resource: Sourceable): Option.Option<Reference> =>
  pipe(
    Option.fromNullable(resource.meta),
    Option.flatMap((meta) => Option.fromNullable(meta.source)),
    Option.filter(isReference)
  )

export { isReference, makeReference, sourceOf, stamp, stampAdopted }
export type { Reference, Sourceable }
