/**
 * What the referent links leave unlinked in a resource as reviewed: the
 * mentions the map could link and its links do not, and whether the
 * resource is left in no patient's compartment. What a review lists as
 * needing a patient or a provider.
 *
 * @remarks
 * Asked of a resource as decoded (or as edited), not as resolved: the plan
 * says where each of its references would be redirected. Only the plan's
 * links are read, so a mention the reviewer chose a link for on its own
 * (a mention link) is still listed, and its row keeps focus once picked.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Data, Option, pipe } from 'effect'

import * as LinkPlan from './link-plan.ts'
import * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as Mention from './mention.ts'

/**
 * A resource that, once its references are redirected, is in no patient's
 * compartment: it has a `subject` slot and nothing in it names a patient of
 * the device or one the map could link, the slot empty, a `display` alone,
 * an absolute URL into another system, a contained `#<id>`, or an untyped
 * identifier.
 *
 * @remarks
 * FHIR's CompartmentDefinition for Patient says which fields place each
 * resource type in a patient's compartment; for every type the importer
 * handles that is `subject`. The viewing apps read by patient, so a resource
 * outside every compartment is one nothing finds. A `subject` that is a
 * logical reference the referent links leave unlinked is a {@link Dangling}
 * mention instead, since the map can still link it.
 */
interface OutsidePatientCompartment {
  readonly _tag: 'OutsidePatientCompartment'
  /** The `DecodedFile.Resource` key of the resource. */
  readonly mentioningResourceKey: string
  /** What its `subject` slot holds as reviewed; `None` when it is empty. */
  readonly subjectAsReviewed: Option.Option<IdentifierAndReference.ReferenceType>
}

/**
 * A mention the map could link and its referent links do not: a linkable
 * logical reference, in any field, whose referent's link target is
 * `Unlinked` or that no link of the plan answers.
 */
interface Dangling {
  readonly _tag: 'Dangling'
  /** The `DecodedFile.Resource` key of the resource carrying the mention. */
  readonly mentioningResourceKey: string
  /** The mention's path in it: see `Mention.Type.path`. */
  readonly mentionPath: string
  /** The reference as reviewed. */
  readonly referenceAsReviewed: IdentifierAndReference.ReferenceType
}

type Type = OutsidePatientCompartment | Dangling

const { OutsidePatientCompartment, Dangling, $is: is, $match: match } = Data.taggedEnum<Type>()

/** Whether `reference` is a linkable logical reference no link of `plan` redirects. */
const isDanglingByReferentLinks = (
  plan: LinkPlan.Type,
  reference: IdentifierAndReference.ReferenceType
): boolean =>
  Option.isSome(LinkableLogicalReference.tryFromReference(reference)) &&
  Option.isNone(LinkPlan.redirectionIfLinked(plan, reference))

/**
 * Whether `subject` names a patient of the device by a relative literal
 * (`Mention.isRelativeLiteral`) or someone the map could link, by a linkable
 * logical reference, which is redirected or else {@link Dangling}.
 */
const namesSomeone = (subject: IdentifierAndReference.ReferenceType): boolean =>
  Mention.isRelativeLiteral(subject) ||
  Option.isSome(LinkableLogicalReference.tryFromReference(subject))

/** What `resource`'s `subject` slot holds; `None` when its type has no such slot. */
const subjectSlotOf = (
  resource: FhirResource
): Option.Option<Option.Option<IdentifierAndReference.ReferenceType>> =>
  Mention.SUBJECT_PATH in resource
    ? Option.some(Option.fromNullable(resource.subject))
    : Option.none()

/**
 * `resource`, reviewed under `reviewKey`, as outside every patient's
 * compartment, when it has a `subject` slot that is empty or names no one
 * ({@link namesSomeone}).
 */
const outsidePatientCompartmentIf = (
  reviewKey: string,
  resource: FhirResource
): Option.Option<Type> =>
  pipe(
    subjectSlotOf(resource),
    Option.filter((subjectAsReviewed) => !Option.exists(subjectAsReviewed, namesSomeone)),
    Option.map((subjectAsReviewed) =>
      OutsidePatientCompartment({ mentioningResourceKey: reviewKey, subjectAsReviewed })
    )
  )

/**
 * What the referent links of `plan` leave unlinked in `resource`, reviewed
 * under `reviewKey`: the resource itself when it is outside every patient's
 * compartment, then each dangling mention, in the walk's order.
 *
 * @param plan - The batch's link plan; only its links are read
 * @param reviewKey - The `DecodedFile.Resource` key the resource is reviewed under
 * @param resource - The resource as decoded, or as the reviewer edited it
 */
const leftByReferentLinks = (
  plan: LinkPlan.Type,
  reviewKey: string,
  resource: FhirResource
): readonly Type[] => [
  ...Option.toArray(outsidePatientCompartmentIf(reviewKey, resource)),
  ...pipe(
    Mention.madeIn(resource),
    Array.filter(({ reference }) => isDanglingByReferentLinks(plan, reference)),
    Array.map(({ path, reference }): Type =>
      Dangling({
        mentioningResourceKey: reviewKey,
        mentionPath: path,
        referenceAsReviewed: reference,
      })
    )
  ),
]

export { is, leftByReferentLinks, match }
export type { Dangling, OutsidePatientCompartment, Type }
