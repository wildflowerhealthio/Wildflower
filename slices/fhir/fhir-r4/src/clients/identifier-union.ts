/**
 * Identifier union: one resource's identifiers joined with the qualified
 * identifiers other resources of the same record carry, each once by the
 * token a search finds it by.
 *
 * @packageDocumentation
 */
import { Array as Arr, HashSet } from 'effect'

import { IdentifierAndReference, type IdentifierType } from '../data-types/index.ts'
import type { FhirResource } from '../resources/fhir-resource.ts'
import * as TokenSearchParam from '../resources/search/token-search-param.ts'
import { qualifiedIdentifiersOf } from './match-query.ts'

/** The search tokens of the qualified identifiers among `identifiers`. */
const tokensOf = (identifiers: readonly IdentifierType[]): HashSet.HashSet<string> =>
  HashSet.fromIterable(
    identifiers
      .filter(IdentifierAndReference.isQualifiedIdentifier)
      .map(TokenSearchParam.fromQualifiedIdentifier)
  )

/** The qualified identifiers `resource` carries that `carried` lacks, each once, in `resource`'s order. */
const missingFrom = (
  carried: readonly IdentifierType[],
  resource: FhirResource
): readonly IdentifierAndReference.QualifiedIdentifierType[] => {
  const carriedTokens = tokensOf(carried)
  return Arr.dedupeWith(
    qualifiedIdentifiersOf(resource).filter(
      (identifier) =>
        !HashSet.has(carriedTokens, TokenSearchParam.fromQualifiedIdentifier(identifier))
    ),
    (left, right) =>
      TokenSearchParam.fromQualifiedIdentifier(left) ===
      TokenSearchParam.fromQualifiedIdentifier(right)
  )
}

/**
 * `carried`, then each qualified identifier of each of `resources` it does
 * not carry yet, in order.
 *
 * @remarks
 * Two identifiers are one when a token search finds them by the same
 * `system|value`; an unqualified identifier among `carried` is kept as it is.
 */
const union = (
  carried: readonly IdentifierType[],
  resources: readonly FhirResource[]
): readonly IdentifierType[] =>
  resources.reduce<readonly IdentifierType[]>(
    (joined, resource) => [...joined, ...missingFrom(joined, resource)],
    carried
  )

export { missingFrom, union }
