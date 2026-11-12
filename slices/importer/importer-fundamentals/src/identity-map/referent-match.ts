/**
 * A referent's default link choice, read off the stored records its record
 * matches (`ImportMatch`): the stored copy of its own record, else the one
 * stored record it matches `certain` or `probable`.
 *
 * @remarks
 * Pure: the match is made once per import, for every record of it, and each
 * referent reads its own candidates here.
 *
 * @packageDocumentation
 */

import type { ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import { Array, HashMap, Option, pipe } from 'effect'

import * as ImportMatch from '../import-match.ts'
import * as LinkChoice from './link-choice.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as ReferentLinkChoiceSet from './referent-link-choice-set.ts'
import * as Referent from './referent.ts'

/** The stored resource of `candidate`, when it is one a referent links to: a Patient or a Practitioner. */
const linkableOf = (candidate: ResourceMatch.Candidate): Option.Option<LinkableResource.WithId> =>
  Option.liftPredicate(candidate.resource, LinkableResource.is)

/**
 * The choice `referent` takes over `storedCopy`, the stored copy of its own
 * resource: `UpdateStoredResource`, so a re-import writes the newer decode
 * over it; but `LinkToStoredResource` for a record the import implied (its
 * `isImplied`), which holds only what a reference said of it and would write
 * over everything else the copy holds.
 */
const storedCopyChoiceOf = (
  referent: Referent.Type,
  storedCopy: LinkableResource.WithId
): LinkChoice.Type =>
  referent.isImplied
    ? LinkChoice.LinkToStoredResource({ resource: storedCopy })
    : LinkChoice.UpdateStoredResource({ resource: storedCopy })

/**
 * The link choice `referent` takes before the reviewer makes one, given the
 * stored records its record matches, best first: the choice over the stored
 * copy of its own resource, under the same literal reference
 * ({@link storedCopyChoiceOf}), whatever else matched; else
 * `LinkToStoredResource` to the one candidate graded `certain` or
 * `probable`; else the default (`ReferentLinkChoiceSet.DEFAULT_CHOICE`).
 *
 * @remarks
 * Two candidates graded `certain` or `probable` (several stored records
 * carrying its identifiers, which the match grades `probable`, or two people
 * sharing its name and birth date), and candidates graded only `possible`,
 * pick no default: the reviewer chooses from the stored list.
 */
const defaultChoice = (
  referent: Referent.Type,
  candidates: readonly ResourceMatch.Candidate[]
): LinkChoice.Type =>
  pipe(
    Array.findFirst(candidates, (candidate) =>
      linkableOf(candidate).pipe(
        Option.filter((stored) => LinkableResource.sameRecord(referent.resource, stored)),
        Option.map((stored) => storedCopyChoiceOf(referent, stored))
      )
    ),
    Option.orElse(() =>
      pipe(
        candidates.filter(({ grade }) => grade === 'certain' || grade === 'probable'),
        Option.liftPredicate((linkable) => linkable.length === 1),
        Option.flatMap(Array.head),
        Option.flatMap(linkableOf),
        Option.map((resource) => LinkChoice.LinkToStoredResource({ resource }))
      )
    ),
    Option.getOrElse(() => ReferentLinkChoiceSet.DEFAULT_CHOICE)
  )

/**
 * {@link defaultChoice} for every referent of `referents`, each over its own
 * record's candidates in `importMatch`, as the referent link choices a
 * review starts from.
 */
const defaultChoices = (
  referents: readonly Referent.Type[],
  importMatch: ImportMatch.Type
): ReferentLinkChoiceSet.Type =>
  HashMap.fromIterable(
    referents.map(
      (referent) =>
        [
          Referent.key(referent),
          defaultChoice(referent, ImportMatch.candidatesOf(importMatch, referent.resource)),
        ] as const
    )
  )

export { defaultChoice, defaultChoices }
