/**
 * A mention: each place a resource names something by a `Reference`, at its
 * path, and where it is redirected.
 *
 * @remarks
 * Mentions are found by `fhir-r4`'s `ResourceReferences` walk, so a reference
 * anywhere in a resource is one: a `subject`, a `requester`, a `performer`
 * of whichever shape its type gives it, a `DiagnosticReport.resultsInterpreter`,
 * a note's `authorReference`. Which type an identifier-only mention names is
 * the reference's own business: a logical reference states its `type`
 * (`LinkableLogicalReference.tryFromReference`), and one that does not names nothing.
 *
 * @packageDocumentation
 */

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  type FhirResourceWithId,
  ReferenceRewrite,
  ResourceReferences,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Option, pipe } from 'effect'

import * as LinkableLogicalReference from './linkable-logical-reference.ts'

/**
 * One mention: the reference as the resource carries it (its literal
 * reference, identifier, `type` and `display`) and its path in the resource,
 * `subject`, `performer[0].actor`, which is what an unlinked mention reports.
 * The mentioning resource is not among them, since every reader already holds
 * it.
 */
type Type = ResourceReferences.ReferenceAt

/** Every mention `resource` makes, in the walk's order. */
const madeIn = (resource: FhirResource): readonly Type[] => ResourceReferences.collect(resource)

/**
 * A relative literal reference, `Type/<id>` with an optional
 * `/_history/<version>`: FHIR's literal reference grammar
 * (https://hl7.org/fhir/R4/references.html#literal) without the base URL,
 * its type and id under FHIR's own patterns.
 */
const RELATIVE_LITERAL_REFERENCE =
  /^[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}(\/_history\/[A-Za-z0-9\-.]{1,64})?$/

/**
 * Whether a reference is a relative literal reference, `Type/<id>`, as
 * opposed to none, an absolute URL into another system, a contained
 * `#<id>`, or text that is no reference at all.
 *
 * @remarks
 * FHIR resolves a relative reference against the server the resource is
 * stored on (https://hl7.org/fhir/R4/references.html#literal), so once
 * imported it names a record of the device.
 */
const isRelativeLiteral = (reference: IdentifierAndReference.ReferenceType): boolean =>
  reference.reference !== null && RELATIVE_LITERAL_REFERENCE.test(reference.reference)

/** The path of the mention that places a resource in a patient's compartment. */
const SUBJECT_PATH = 'subject'

/** Whether `resource` has a `subject` slot that holds no reference. */
const hasEmptySubject = (resource: FhirResource): boolean =>
  SUBJECT_PATH in resource && resource.subject === null

/**
 * A mention of a type the identity map links, the type among it: what a
 * reviewer may choose a link for on its own (`MentionLinkChoiceSet`).
 */
interface Linkable extends Type {
  readonly type: LinkableLogicalReference.ResourceType
}

/**
 * The type a mention names, when it is one the identity map links: the one
 * its reference states, by `type` or by its relative literal reference; or,
 * for a `subject` that states none, a `Patient`, since FHIR's Patient
 * CompartmentDefinition names `subject` for every type the importer handles.
 * `None` for a stated type the map does not link (an `Observation` a report
 * results in, a `Group` subject, an `Organization` performer) and for a
 * reference anywhere else that states none.
 */
const linkableTypeOf = ({
  path,
  reference,
}: Type): Option.Option<LinkableLogicalReference.ResourceType> =>
  pipe(
    Option.fromNullable(reference.type),
    Option.orElse(() =>
      pipe(
        Option.liftPredicate(reference, isRelativeLiteral),
        Option.flatMapNullable((relativeLiteral) => relativeLiteral.reference),
        Option.flatMap((literal) => Array.head(literal.split('/')))
      )
    ),
    Option.match({
      onNone: () => Option.liftPredicate('Patient' as const, () => path === SUBJECT_PATH),
      onSome: (stated) => Option.liftPredicate(stated, LinkableLogicalReference.isResourceType),
    })
  )

/**
 * An empty `subject` slot as a mention: an empty reference a patient can be
 * chosen for, a `subject` naming a `Patient` whatever it states.
 */
const emptySubject: Linkable = {
  path: SUBJECT_PATH,
  reference: IdentifierAndReference.emptyReference,
  type: 'Patient',
}

/**
 * Every mention of `resource` a reviewer may choose a link for: each one it
 * makes that names a type the map links, and, when its `subject` slot is
 * empty, that slot as an empty reference, so a patient can be chosen for a
 * resource that names none.
 */
const linkableIn = (resource: FhirResource): readonly Linkable[] => [
  ...(hasEmptySubject(resource) ? [emptySubject] : []),
  ...Array.filterMap(madeIn(resource), (mention) =>
    Option.map(linkableTypeOf(mention), (type): Linkable => ({ ...mention, type }))
  ),
]

/** The mention at `mentionPath` in `resource`, `None` when it makes none there. */
const at = (resource: FhirResource, mentionPath: string): Option.Option<Type> =>
  Array.findFirst(madeIn(resource), (mention) => mention.path === mentionPath)

/** Whether a reference names nothing at all: no literal, identifier or `display`. */
const namesNothing = (reference: IdentifierAndReference.ReferenceType): boolean =>
  reference.reference === null && reference.identifier === null && reference.display === null

/**
 * The literal reference `reference` is written with when relinked to
 * `literalReference`: that one, or, for `None`, `null`, its literal dropped.
 * `None` when dropping it would leave a reference that names nothing at all,
 * since an empty reference is not one: the mention is then left as it is.
 */
const relinkedLiteral = (
  reference: IdentifierAndReference.ReferenceType,
  literalReference: Option.Option<string>
): Option.Option<string | null> =>
  Option.match(literalReference, {
    onSome: (literal) => Option.some(literal),
    onNone: () =>
      namesNothing({ ...reference, reference: null }) ? Option.none() : Option.some(null),
  })

/**
 * `resource` with the mention at `mentionPath` relinked: its literal
 * reference set to `literalReference`, or, for `None`, dropped
 * ({@link relinkedLiteral}).
 *
 * @param resource - The resource whose mention moves
 * @param mentionPath - The mention's path (`Type.path`)
 * @param literalReference - The `Type/<id>` to redirect it to, or `None` for no
 *   resource of the device
 * @returns `resource` itself when nothing changes; otherwise a copy that
 *   differs only at that mention
 *
 * @remarks
 * The mention keeps its `identifier` and `display`, so an identifier-only
 * mention is relinked the way the resolution redirects one. An empty
 * `subject` slot is no reference, so no rewrite reaches it: it is filled by
 * a literal reference and stays empty for `None`.
 */
const relinked = (
  resource: FhirResourceWithId,
  mentionPath: string,
  literalReference: Option.Option<string>
): FhirResourceWithId =>
  mentionPath === SUBJECT_PATH && hasEmptySubject(resource)
    ? Option.match(literalReference, {
        onNone: () => resource,
        onSome: (subjectLiteral) => ({
          ...resource,
          subject: { ...IdentifierAndReference.emptyReference, reference: subjectLiteral },
        }),
      })
    : ReferenceRewrite.apply(resource, (found) =>
        found.path === mentionPath
          ? relinkedLiteral(found.reference, literalReference)
          : Option.none()
      )

export {
  at,
  emptySubject,
  hasEmptySubject,
  isRelativeLiteral,
  linkableIn,
  linkableTypeOf,
  madeIn,
  relinked,
  relinkedLiteral,
  SUBJECT_PATH,
}
export type { Linkable, Type }
