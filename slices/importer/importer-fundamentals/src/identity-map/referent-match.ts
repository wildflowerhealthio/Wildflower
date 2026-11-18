/**
 * A referent's default link choice, read off its resource's stored
 * candidates (`StoredCandidates`): the choice over the stored copy of its own
 * resource, else a link to the one stored resource it matches strongly.
 *
 * @remarks
 * Pure. The import is matched once, every resource in one `matchAll`, and
 * each referent reads its own resource's candidates here.
 *
 * @packageDocumentation
 */

import { MatchGrade, type ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import { Array, HashMap, Option, pipe } from 'effect'

import * as StoredCandidates from '../stored-candidates.ts'
import * as LinkChoice from './link-choice.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as ReferentLinkChoiceSet from './referent-link-choice-set.ts'
import * as Referent from './referent.ts'

/** A candidate a referent can link to: its stored resource is a Patient or a Practitioner. */
interface LinkableCandidate {
  readonly resource: LinkableResource.WithId
  readonly grade: MatchGrade.Type
}

/** The candidates of `candidates` a referent can link to. */
const linkableOf = (candidates: readonly ResourceMatch.Candidate[]): readonly LinkableCandidate[] =>
  Array.filterMap(candidates, ({ resource, grade }) =>
    Option.map(Option.liftPredicate(resource, LinkableResource.is), (linkable) => ({
      resource: linkable,
      grade,
    }))
  )

/**
 * The choice over the candidate stored under `referent`'s own literal
 * reference: `UpdateStoredResource`, so a re-import writes the newer decode
 * over it.
 *
 * @remarks
 * A referent the import implied (its `isImplied`) takes
 * `LinkToStoredResource` instead. Its resource holds only what a reference
 * said of it, and writing it would overwrite everything else the stored copy
 * holds.
 */
const ownStoredCopyChoice = (
  referent: Referent.Type,
  candidates: readonly LinkableCandidate[]
): Option.Option<LinkChoice.Type> =>
  pipe(
    Array.findFirst(candidates, ({ resource }) =>
      LinkableResource.sameRecord(referent.resource, resource)
    ),
    Option.map(({ resource }) =>
      referent.isImplied
        ? LinkChoice.LinkToStoredResource({ resource })
        : LinkChoice.UpdateStoredResource({ resource })
    )
  )

/** `LinkToStoredResource` to the one candidate graded `certain` or `probable`, when there is exactly one. */
const soleStrongCandidateChoice = (
  candidates: readonly LinkableCandidate[]
): Option.Option<LinkChoice.Type> =>
  pipe(
    candidates.filter(({ grade }) => MatchGrade.isStrong(grade)),
    Option.liftPredicate((strong) => strong.length === 1),
    Option.flatMap(Array.head),
    Option.map(({ resource }) => LinkChoice.LinkToStoredResource({ resource }))
  )

/**
 * The link choice `referent` takes before the reviewer makes one, given its
 * resource's stored candidates, best first.
 *
 * @remarks
 * The choice over the stored copy of its own resource comes first
 * ({@link ownStoredCopyChoice}), whatever else matched. Else the referent
 * links to the one candidate graded `certain` or `probable`
 * ({@link soleStrongCandidateChoice}). Else it takes `CreateResource`
 * (`ReferentLinkChoiceSet.DEFAULT_CHOICE`). So two strong candidates give
 * `CreateResource`, as do candidates graded only `possible`. The reviewer
 * then chooses from the stored list.
 */
const defaultChoice = (
  referent: Referent.Type,
  candidates: readonly ResourceMatch.Candidate[]
): LinkChoice.Type => {
  const linkable = linkableOf(candidates)
  return pipe(
    ownStoredCopyChoice(referent, linkable),
    Option.orElse(() => soleStrongCandidateChoice(linkable)),
    Option.getOrElse(() => ReferentLinkChoiceSet.DEFAULT_CHOICE)
  )
}

/** The {@link defaultChoice} of every referent of `referents`, by `Referent.key`. */
const defaultChoices = (
  referents: readonly Referent.Type[],
  storedCandidates: StoredCandidates.Type
): ReferentLinkChoiceSet.Type =>
  HashMap.fromIterable(
    referents.map(
      (referent) =>
        [
          Referent.key(referent),
          defaultChoice(referent, StoredCandidates.of(storedCandidates, referent.resource)),
        ] as const
    )
  )

export { defaultChoice, defaultChoices }
