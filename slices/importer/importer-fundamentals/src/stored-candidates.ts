/**
 * The stored candidates of an import's resources: for each resource, the
 * stored resources `ResourceMatch.findCandidates` grades as copies of the same
 * record, and the identifiers it was matched by.
 *
 * @remarks
 * An import is matched once, every resource in one `findCandidates`, so the
 * referents' default link choices (`ReferentMatch`) and the server diff
 * (`StoredCopy`) read the same candidates.
 *
 * @packageDocumentation
 */

import {
  distinctByReference,
  type FhirR4ResourcesHttpApiClient,
  MatchQuery,
  ResourceMatch,
} from '@wildflowerhealthio/fhir-r4/clients'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResourceWithId, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Effect, HashMap, Option } from 'effect'

/** One matched resource's stored candidates. */
interface Entry {
  /** The qualified identifiers the resource carried when it was matched. */
  readonly matchedBy: readonly IdentifierAndReference.QualifiedIdentifierType[]
  /** The stored resources it matched, best grade first. */
  readonly candidates: readonly ResourceMatch.Candidate[]
}

/** Each matched resource's {@link Entry}, by the resource's literal reference. */
type Type = HashMap.HashMap<string, Entry>

/** No resource matched. */
const empty: Type = HashMap.empty()

/**
 * The stored candidates of `resources`, every grade, from one
 * `ResourceMatch.findCandidates`.
 *
 * @remarks
 * A literal reference is matched once. When several of `resources` share
 * one, the first of them is the one matched.
 *
 * @param resources - The import's resources
 * @returns The stored candidates; fails when any search fails, since a
 *   failed search is not "no match"
 */
const find = (
  resources: readonly FhirResourceWithId[]
): Effect.Effect<Type, ResourceMatch.Failure, FhirR4ResourcesHttpApiClient> => {
  const matched = distinctByReference(resources)
  const queries: readonly MatchQuery.Type[] = matched.map(MatchQuery.fromResource)
  return Effect.map(
    ResourceMatch.findCandidates(queries, {
      onlyCertainMatches: false,
      count: Option.none(),
    }),
    (candidatesPerResource): Type =>
      HashMap.fromIterable(
        Array.zipWith(
          matched,
          candidatesPerResource,
          (resource, candidates) =>
            [
              literalReferenceOf(resource),
              { matchedBy: MatchQuery.qualifiedIdentifiersOf(resource), candidates },
            ] as const
        )
      )
  )
}

/** The stored candidates of `resource`, by its literal reference; empty when it was not matched. */
const of = (
  storedCandidates: Type,
  resource: FhirResourceWithId
): readonly ResourceMatch.Candidate[] =>
  HashMap.get(storedCandidates, literalReferenceOf(resource)).pipe(
    Option.match({ onNone: () => [], onSome: ({ candidates }) => candidates })
  )

export { empty, find, of }
export type { Entry, Type }
