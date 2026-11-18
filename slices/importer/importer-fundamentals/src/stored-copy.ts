/**
 * A resource's stored copy: the stored resource its identifiers name, which
 * the server diff compares it with, whatever its id.
 *
 * @remarks
 * Read off the import's stored candidates (`StoredCandidates`), so it takes
 * no request. The candidates were found by the identifiers the resource
 * carried when it was matched. So a resource the review has since given
 * other identifiers has no stored copy here. The diff reads the copy under
 * the resource's own id for a resource without one, which is always safe.
 *
 * @packageDocumentation
 */

import { MatchQuery, type ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResourceWithId,
  literalReferenceOf,
  TokenSearchParam,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Equal, HashMap, HashSet, Option, pipe } from 'effect'

import type * as StoredCandidates from './stored-candidates.ts'

/** `identifiers` as a set of the tokens the match searches them by. */
const tokenSetOf = (
  identifiers: readonly IdentifierAndReference.QualifiedIdentifierType[]
): HashSet.HashSet<string> =>
  HashSet.fromIterable(identifiers.map(TokenSearchParam.fromQualifiedIdentifier))

/** Whether `resource` carries exactly the qualified identifiers `entry` was matched by, in any order. */
const carriesMatchedIdentifiers = (
  resource: FhirResourceWithId,
  entry: StoredCandidates.Entry
): boolean =>
  Equal.equals(tokenSetOf(MatchQuery.qualifiedIdentifiersOf(resource)), tokenSetOf(entry.matchedBy))

/**
 * The stored copy among `candidates` found by identifier: the one graded
 * `certain`. When several were found, each is graded `probable`, and the
 * copy is the one stored under `resource`'s own literal reference.
 */
const copyFoundByIdentifier = (
  resource: FhirResourceWithId,
  candidates: readonly ResourceMatch.Candidate[]
): Option.Option<FhirResourceWithId> => {
  const byIdentifier = candidates.filter(({ by }) => by === 'identifier')
  return pipe(
    Array.findFirst(byIdentifier, ({ grade }) => grade === 'certain'),
    Option.orElse(() =>
      Array.findFirst(
        byIdentifier,
        (candidate) => literalReferenceOf(candidate.resource) === literalReferenceOf(resource)
      )
    ),
    Option.map((candidate) => candidate.resource)
  )
}

/**
 * The stored copy of `resource` in `storedCandidates`.
 *
 * @remarks
 * `None` when `resource` was not matched, or carries qualified identifiers
 * other than the ones it was matched by. `None` too when no candidate was
 * found by identifier, which is always so for a resource with no qualified
 * identifier and for a `Binary`. And `None` when several were, none under
 * `resource`'s own literal reference.
 */
const of = (
  storedCandidates: StoredCandidates.Type,
  resource: FhirResourceWithId
): Option.Option<FhirResourceWithId> =>
  pipe(
    HashMap.get(storedCandidates, literalReferenceOf(resource)),
    Option.filter((entry) => carriesMatchedIdentifiers(resource, entry)),
    Option.flatMap(({ candidates }) => copyFoundByIdentifier(resource, candidates))
  )

export { of }
