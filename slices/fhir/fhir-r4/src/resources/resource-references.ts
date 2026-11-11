/**
 * Every `Reference` a decoded resource carries, at any depth, each at its
 * path: found by `fhir-r4`'s own `Reference` schema rather than a list of
 * field names, so a reference anywhere in a resource is reached.
 *
 * @packageDocumentation
 */

import { Schema } from 'effect'

import {
  ReferenceSchema,
  type ReferenceType as Reference,
} from '../data-types/complex/identifier-and-reference.ts'
import type { FhirResource } from './fhir-resource.ts'
import { mapTargets } from './resource-walk.ts'

const isReferenceSchema = Schema.is(Schema.typeSchema(ReferenceSchema))

/**
 * Whether a decoded record is a `Reference`, as `fhir-r4`'s schema decides.
 * The key test only spares the schema check on the records that cannot be one.
 */
const isReference = (record: object): record is Reference =>
  'reference' in record && isReferenceSchema(record)

/**
 * A `Reference` at its path in the resource: `subject`, `performer[1]`,
 * `performer[0].actor`, `contained[0].subject`. Fields are joined with `.`,
 * array elements indexed with `[n]`.
 */
interface ReferenceAt {
  readonly path: string
  readonly reference: Reference
}

/**
 * `resource` with `rewrite` applied to every `Reference` it carries, at any
 * depth, each handed with its path (as {@link collect} spells it), so a
 * rewrite can single one reference out.
 *
 * @remarks
 * The walk rebuilds only the records and arrays something changed in, and
 * replaces a `Reference` only with what `rewrite` returns for it, so the
 * result has `resource`'s own shape, and a resource nothing changed in comes
 * back as itself. The type system cannot follow a walk over every field,
 * hence the one assertion; the property tests pin the shape.
 */
const mapReferences = <TResource extends FhirResource>(
  resource: TResource,
  rewrite: (reference: Reference, path: string) => Reference
): TResource =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the walk keeps the shape; see @remarks
  mapTargets(resource, '', isReference, rewrite) as TResource

/** Every `Reference` `resource` carries, at any depth, at its path, each before the references nested in it. */
const collect = (resource: FhirResource): readonly ReferenceAt[] => {
  const found: ReferenceAt[] = []
  mapTargets(resource, '', isReference, (reference, path) => {
    found.push({ path, reference })
    return reference
  })
  return found
}

export { collect, mapReferences }
export type { ReferenceAt }
