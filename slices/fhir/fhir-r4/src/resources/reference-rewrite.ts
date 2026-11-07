/**
 * A reference rewrite: for each `Reference` a resource carries, at its path,
 * the literal reference to write in its place, or none to leave it as it is.
 * Its `type`, `identifier` and `display` are always kept, so a rewrite only
 * ever says where a reference points.
 *
 * @remarks
 * The rewrite gives a literal, not a whole `Reference`: `null` drops the
 * literal (a link taken back), a `Type/<id>` sets it. Keeping the codomain to
 * the one field a rewrite changes lets {@link apply} keep a reference whose
 * literal it already carries, so a resource nothing moves in comes back as
 * itself.
 *
 * @packageDocumentation
 */

import { Option } from 'effect'

import type { ReferenceType } from '../data-types/complex/identifier-and-reference.ts'
import type { FhirResource } from './fhir-resource.ts'
import * as ResourceReferences from './resource-references.ts'

/**
 * The literal reference written at `at` instead of the one there, `null` to
 * drop it; `None` leaves the reference as it is.
 */
type Type = (at: ResourceReferences.ReferenceAt) => Option.Option<string | null>

/** The rewrite that leaves every reference as it is. */
const none: Type = () => Option.none()

/** `first`'s literal where it gives one, else `second`'s. */
const orElse =
  (first: Type, second: Type): Type =>
  (at) =>
    Option.orElse(first(at), () => second(at))

/**
 * A rewrite that reads only the reference, wherever it is: `lookup`'s
 * literal for it, none where `lookup` has none.
 */
const fromLookup =
  (lookup: (reference: ReferenceType) => Option.Option<string>): Type =>
  ({ reference }) =>
    lookup(reference)

/**
 * `resource` with every reference it carries, at any depth, rewritten by
 * `rewrite` (`ResourceReferences.mapReferences`). A reference whose literal
 * `rewrite` leaves, or already carries, is kept as itself, so a resource
 * nothing moves in comes back as itself.
 */
const apply = <TResource extends FhirResource>(resource: TResource, rewrite: Type): TResource =>
  ResourceReferences.mapReferences(resource, (reference, path) =>
    Option.match(
      Option.filter(rewrite({ path, reference }), (literal) => literal !== reference.reference),
      {
        onNone: () => reference,
        onSome: (literal) => ({ ...reference, reference: literal }),
      }
    )
  )

export { apply, fromLookup, none, orElse }
export type { Type }
