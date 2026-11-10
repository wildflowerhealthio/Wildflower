/**
 * Resolving a decoded file on its batch's link plan: each decoded resource
 * written as the resource the plan has for it, with its mentions redirected to
 * their referents' link targets, or redirected where the reviewer chose for one
 * on its own; and the records the batch only mentions, as the batch's own
 * linked records. Every function takes the plan first, since it is fixed for
 * a batch.
 *
 * @packageDocumentation
 */

import { type FhirResourceWithId, ReferenceRewrite } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Option, pipe } from 'effect'

import type * as ReviewRow from '../review-row.ts'
import * as SectionedList from '../sectioned-list.ts'
import * as LinkPlan from './link-plan.ts'
import * as LinkTarget from './link-target.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Mention from './mention.ts'

/** The review key a resource the batch only mentions is reviewed under, among the batch's linked records. */
const linkedKey = (onlyMentioned: LinkableResource.WithId): string =>
  `linked:${LinkableResource.literalReferenceOf(onlyMentioned)}`

/**
 * `resource`, reviewed under `reviewKey`, with its `subject` slot filled
 * where it is empty and the reviewer chose a patient for it: an empty slot
 * is no reference, so no rewrite reaches it. The same object otherwise.
 */
const withChosenSubject = (
  plan: LinkPlan.Type,
  reviewKey: string,
  resource: FhirResourceWithId
): FhirResourceWithId =>
  Mention.hasEmptySubject(resource)
    ? pipe(
        LinkPlan.linkTargetIfChosenForMention(plan, reviewKey, Mention.emptySubject),
        Option.flatMap(LinkTarget.resourceIfLinked),
        Option.match({
          onNone: () => resource,
          onSome: (patient) =>
            Mention.relinked(
              resource,
              Mention.SUBJECT_PATH,
              Option.some(LinkableResource.literalReferenceOf(patient))
            ),
        })
      )
    : resource

/**
 * The rewrite of each reference the reviewer chose a link for on its own, in
 * the resource reviewed under `reviewKey`: its literal set where the choice
 * (`LinkPlan.linkTargetIfChosenForMention`) says, or dropped for `Unlinked`
 * (`Mention.relinkedLiteral`). A reference that is no linkable mention, or
 * that no choice is for, is left.
 */
const chosenMentionRewrite =
  (plan: LinkPlan.Type, reviewKey: string): ReferenceRewrite.Type =>
  (at) =>
    pipe(
      Mention.linkableTypeOf(at),
      Option.flatMap((type) =>
        LinkPlan.linkTargetIfChosenForMention(plan, reviewKey, { ...at, type })
      ),
      Option.flatMap((target) =>
        Mention.relinkedLiteral(
          at.reference,
          Option.map(LinkTarget.resourceIfLinked(target), LinkableResource.literalReferenceOf)
        )
      )
    )

/**
 * Where `plan` points the references of the resource reviewed under
 * `reviewKey`: each mention the reviewer chose a link for on its own where
 * that choice says, over every reference that names a referent, redirected
 * to its referent's link target (`LinkPlan.redirectionIfLinked`). Every
 * other reference is left as decoded.
 */
const rewriteOf = (plan: LinkPlan.Type, reviewKey: string): ReferenceRewrite.Type =>
  ReferenceRewrite.orElse(
    chosenMentionRewrite(plan, reviewKey),
    ReferenceRewrite.fromLookup((reference) => LinkPlan.redirectionIfLinked(plan, reference))
  )

/**
 * `mentioningResource`, reviewed under `reviewKey`, with every reference
 * pointed where `plan` says ({@link rewriteOf}): each mention the
 * reviewer chose a link for on its own where that choice says, over every
 * other redirected to its referent's link target. Walks every reference, not
 * only the mention fields, so a provider named elsewhere moves too, keeping
 * its `display` and its own `identifier`. An empty `subject` slot chosen for
 * is filled. The same object when nothing moves.
 */
const redirectReferences = (
  plan: LinkPlan.Type,
  reviewKey: string,
  mentioningResource: FhirResourceWithId
): FhirResourceWithId =>
  withChosenSubject(
    plan,
    reviewKey,
    ReferenceRewrite.apply(mentioningResource, rewriteOf(plan, reviewKey))
  )

/** Whether `after` holds the very resource and title `before` does. */
const sameRow = (before: ReviewRow.Type, after: ReviewRow.Type): boolean =>
  after.resource === before.resource && after.title === before.title

/**
 * `decodedRow` as it is resolved under `plan`: a referent's resource
 * written as its resolved resource (a stored resource standing in for it, or
 * itself having assumed what the referents linked to it bring), any other
 * written as decoded, with its mentions redirected either way, those the
 * reviewer chose a link for under the row's review key where their
 * choice says. A row whose resource the resolved one replaces under another id
 * takes the resolved resource's label as its title; any other keeps its own.
 * The same object when nothing changes.
 */
const resolveRow =
  (plan: LinkPlan.Type) =>
  (decodedRow: DecodedFile.Row): DecodedFile.Row => {
    const redirect = redirectMentions(plan, decodedRow.reviewable.key)
    const resolvedRow = Option.match(
      LinkPlan.resolvedResourceIfReferent(plan, decodedRow.resource),
      {
        onNone: () => ({
          ...decodedRow,
          resource: redirect(decodedRow.resource),
        }),
        onSome: (resolvedResource) => ({
          reviewable:
            resolvedResource.resource.id === decodedRow.resource.id
              ? decodedRow.reviewable
              : { ...decodedRow.reviewable, title: resolvedResource.label },
          resource: redirect(resolvedResource.resource),
        }),
      }
    )
    return sameRow(decodedRow, resolvedRow) ? decodedRow : resolvedRow
  }

/**
 * `editedResource`, the reviewer's edit of the resource reviewed under
 * `reviewKey`, as it is resolved under `plan`: its mentions redirected as a
 * decoded row's are ({@link redirectReferences}), so a mention the edit
 * names by a decoded literal reference a stored resource now stands in for,
 * or one the reviewer chose a link for, is written where the plan says
 * today, not where it pointed when the edit was made. The edit itself is
 * never replaced by a resolved resource: it is what the reviewer wants
 * written. The same object when nothing moves.
 */
const resolveEdit = (
  plan: LinkPlan.Type,
  reviewKey: string
): ((editedResource: FhirResourceWithId) => FhirResourceWithId) => redirectMentions(plan, reviewKey)

/**
 * The batch's linked records under `plan`: the resolved resources no
 * resolved file holds where a decoded resource was, as they will be
 * written, in the order the links first reach them. No resolved file holds
 * them; they are the batch's own, reviewed and written beside the files.
 */
const linkedRecords = (plan: LinkPlan.Type): readonly ReviewRow.Type[] =>
  pipe(
    LinkPlan.resolvedResources(plan),
    Array.filter(({ resourceExistsInBatch }) => !resourceExistsInBatch),
    Array.map(({ resource, label }): ReviewRow.Type => ({
      reviewKey: linkedKey(resource),
      title: label,
      isImplied: false,
      resource,
    }))
  )

/**
 * `decodedFile` resolved on `plan`: the file to review, diff and write. Every
 * section keeps its keys, and a row nothing changed in comes back as the
 * same object. The records the batch only mentions are no file's: they are
 * {@link linkedRecords}.
 */
const resolveFile =
  (plan: LinkPlan.Type) =>
  (decodedFile: DecodedFile.DecodedFile): DecodedFile.DecodedFile => {
    const rows = SectionedList.map(decodedFile.rows, resolveRow(plan))
    return rows === decodedFile.rows ? decodedFile : { ...decodedFile, rows }
  }

export { linkedKey, linkedRecords, resolveEdit, resolveFile }
