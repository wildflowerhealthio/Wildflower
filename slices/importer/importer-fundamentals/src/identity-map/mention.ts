/**
 * A mention: each place a resource names something by a `Reference`, at its
 * path, and where it lands.
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
import { type FhirResource, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Option } from 'effect'

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
 * Whether a reference lands on a record of the device: a relative literal
 * reference, `Type/<id>`, as opposed to none, an absolute URL into another
 * system, a contained `#<id>`, or text that is no reference at all.
 */
const landsOnDevice = (reference: IdentifierAndReference.ReferenceType): boolean =>
  reference.reference !== null && RELATIVE_LITERAL_REFERENCE.test(reference.reference)

/** The path of the mention that places a resource in a patient's compartment. */
const SUBJECT_PATH = 'subject'

/**
 * A mention of a type the identity map links, the type among it: what a
 * reviewer may choose a link for on its own (`MentionLinkChoices`).
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
}: Type): Option.Option<LinkableLogicalReference.ResourceType> => {
  const ofLiteral = landsOnDevice(reference)
    ? Option.fromNullable(reference.reference).pipe(
        Option.map((literal) => literal.split('/')[0] ?? '')
      )
    : Option.none()
  return Option.match(
    Option.orElse(Option.fromNullable(reference.type), () => ofLiteral),
    {
      onNone: () => (path === SUBJECT_PATH ? Option.some('Patient' as const) : Option.none()),
      onSome: (stated) => Option.liftPredicate(stated, LinkableLogicalReference.isResourceType),
    }
  )
}

/**
 * Every mention of `resource` a reviewer may choose a link for: each one it
 * makes that names a type the map links, and, when its `subject` slot is
 * empty, that slot as an empty reference, so a patient can be chosen for a
 * resource that names none.
 */
const linkableIn = (resource: FhirResource): readonly Linkable[] => {
  const emptySubject: readonly Type[] =
    SUBJECT_PATH in resource && resource.subject === null
      ? [{ path: SUBJECT_PATH, reference: IdentifierAndReference.emptyReference }]
      : []
  return Array.filterMap([...emptySubject, ...madeIn(resource)], (mention) =>
    Option.map(linkableTypeOf(mention), (type): Linkable => ({ ...mention, type }))
  )
}

/** The mention at `mentionPath` in `resource`, `None` when it makes none there. */
const at = (resource: FhirResource, mentionPath: string): Option.Option<Type> =>
  Array.findFirst(madeIn(resource), (mention) => mention.path === mentionPath)

/** Whether a reference names nothing at all: no literal, identifier or `display`. */
const namesNothing = (reference: IdentifierAndReference.ReferenceType): boolean =>
  reference.reference === null && reference.identifier === null && reference.display === null

/**
 * `resource` with the mention at `mentionPath` relinked: its literal
 * reference set to `literalReference`, or, for `None`, dropped.
 *
 * @param resource - The resource whose mention moves
 * @param mentionPath - The mention's path (`Type.path`)
 * @param literalReference - The `Type/<id>` to land on, or `None` for no
 *   resource of the device
 * @returns `resource` itself when nothing changes; otherwise a copy that
 *   differs only at that mention
 *
 * @remarks
 * The mention keeps its `identifier` and `display`, so an identifier-only
 * mention is relinked the way the resolution redirects one. Dropping the
 * literal of a mention that would then name nothing at all changes nothing,
 * since an empty reference is not one. An empty `subject` slot is filled by
 * a literal reference and stays empty for `None`.
 */
const relinked = <TResource extends FhirResource>(
  resource: TResource,
  mentionPath: string,
  literalReference: Option.Option<string>
): TResource =>
  Option.match(at(resource, mentionPath), {
    onNone: () =>
      Option.match(literalReference, {
        onNone: () => resource,
        onSome: (reference) =>
          mentionPath === SUBJECT_PATH && SUBJECT_PATH in resource && resource.subject === null
            ? { ...resource, subject: { ...IdentifierAndReference.emptyReference, reference } }
            : resource,
      }),
    onSome: ({ reference: current }) => {
      const reference = Option.getOrNull(literalReference)
      if (current.reference === reference) return resource
      const moved = { ...current, reference }
      if (namesNothing(moved)) return resource
      return ResourceReferences.mapReferences(resource, (found, path) =>
        path === mentionPath ? moved : found
      )
    },
  })

export { at, landsOnDevice, linkableIn, linkableTypeOf, madeIn, relinked, SUBJECT_PATH }
export type { Linkable, Type }
