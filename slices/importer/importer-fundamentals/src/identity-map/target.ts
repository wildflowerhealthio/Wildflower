/**
 * What a row of the identity review becomes on the device.
 *
 * @remarks
 * A resource-backed row targets a stored resource or `'new'` (its own
 * resource is written and becomes the person or provider). An id-only row
 * targets a stored resource, another row (the resource that row writes), or
 * `'dontLink'` (its references keep their identifier-only form). Following
 * `row` targets to the end gives a {@link Resolved}.
 *
 * @packageDocumentation
 */

import type { Patient, Practitioner } from '@wildflowerhealthio/fhir-r4/resources'

import type * as IdentityRow from './identity-row.ts'

/** A `Patient` or `Practitioner` already on the device, so one with an `id`. */
type StoredResource =
  | (Patient.Type & { readonly id: string })
  | (Practitioner.Type & { readonly id: string })

/** Link the row to a resource already on the device. */
interface Stored {
  readonly _tag: 'stored'
  readonly resource: StoredResource
}

/** Link an id-only row to whatever the row keyed `key` (an `IdentityRow.key`) becomes. */
interface Row {
  readonly _tag: 'row'
  readonly key: string
}

type Type = 'new' | Stored | Row | 'dontLink'

/** A resource-backed row whose own resource is written and becomes the person or provider. */
interface NewFromRow {
  readonly _tag: 'newFromRow'
  readonly row: IdentityRow.ResourceBacked
}

/** What a row's target comes to once every `row` target on the way is followed. */
type Resolved = Stored | NewFromRow | 'dontLink'

/** The target linking a row to `resource`, already on the device. */
const stored = (resource: StoredResource): Stored => ({ _tag: 'stored', resource })

/** The target linking an id-only row to what the row keyed `key` becomes. */
const row = (key: string): Row => ({ _tag: 'row', key })

/** Whether a target, or what one resolves to, is a stored resource. */
const isStored = (target: Type | Resolved | undefined): target is Stored =>
  typeof target === 'object' && target._tag === 'stored'

/** Whether a target links to another row. */
const isRow = (target: Type): target is Row => typeof target !== 'string' && target._tag === 'row'

export { isRow, isStored, row, stored }
export type { NewFromRow, Resolved, Row, Stored, StoredResource, Type }
