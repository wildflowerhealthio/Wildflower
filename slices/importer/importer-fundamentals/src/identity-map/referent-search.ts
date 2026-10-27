/**
 * The one server read the identity map needs: a referent's default link
 * choice, found by searching the device for the identifiers the referent
 * answers to.
 *
 * @remarks
 * The search is by identifier only. Demographics are identifiers too
 * (`LinkableResource.maybeDerivedIdentifier`, a referent's
 * `derivedIdentifier`), searched after the identifiers a source gave it.
 *
 * @packageDocumentation
 */

import {
  FhirR4ResourcesHttpApiClient,
  type FhirR4ResourcesHttpApiClientShape,
} from '@wildflowerhealthio/fhir-r4/clients'
import { TokenSearchParam } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Data, Effect, HashMap, Match, Option } from 'effect'

import * as LinkChoice from './link-choice.ts'
import type * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as LinkableResource from './linkable-resource.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import * as Referent from './referent.ts'

/**
 * A searchset entry that matched the search without carrying the resource it
 * matched: an answer that names a record without giving it, which can neither
 * be linked to nor counted out.
 */
class MatchWithoutResource extends Data.TaggedError('MatchWithoutResource')<{
  readonly resourceType: LinkableLogicalReference.ResourceType
}> {}

/**
 * What a search can fail with: the typed client's own failures, the same for
 * every resource type's search, and a match that carries no resource.
 */
type SearchFailure =
  | Effect.Effect.Error<ReturnType<FhirR4ResourcesHttpApiClientShape['Patient']['SearchByGet']>>
  | MatchWithoutResource

/** How many referents {@link defaultChoices} searches for at once. */
const SEARCH_CONCURRENCY = 4

/**
 * How many entries a search asks for: one more than it links to, so a second
 * hit reads as an ambiguous match rather than going unseen.
 */
const SEARCH_COUNT = 2

/** A searchset entry as the search reads it: what it matched, and how it came to be in the answer. */
interface SearchsetEntry<TResource> {
  readonly resource: TResource | null
  readonly search: { readonly mode: string | null } | null
}

/**
 * The stored resources `bundle`'s matches carry: every entry but an outcome
 * (a server's note about the search), each with its resource. A match without
 * one fails the search ({@link MatchWithoutResource}) rather than going
 * uncounted, since the count is what tells one hit from an ambiguous match.
 */
const matchesIn = <TResource>(
  resourceType: LinkableLogicalReference.ResourceType,
  bundle: { readonly entry: readonly SearchsetEntry<TResource>[] }
): Effect.Effect<readonly TResource[], MatchWithoutResource> =>
  Effect.forEach(
    bundle.entry.filter((entry) => entry.search?.mode !== 'outcome'),
    ({ resource }) =>
      resource === null
        ? Effect.fail(new MatchWithoutResource({ resourceType }))
        : Effect.succeed(resource)
  )

/**
 * The stored resources of `resourceType` that any of `logicalReferences`
 * names, up to {@link SEARCH_COUNT}: one `GET <Type>?identifier=<tokens>`,
 * or none, and nothing, when there is no reference to search by.
 */
const storedNamedBy = (
  resourceType: LinkableLogicalReference.ResourceType,
  logicalReferences: readonly LinkableLogicalReference.Type[]
): Effect.Effect<readonly LinkableResource.WithId[], SearchFailure, FhirR4ResourcesHttpApiClient> =>
  Array.match(logicalReferences, {
    onEmpty: () => Effect.succeed([]),
    onNonEmpty: (named) =>
      Effect.flatMap(FhirR4ResourcesHttpApiClient, (client) => {
        const request = {
          urlParams: {
            identifier: TokenSearchParam.anyOf(
              Array.map(named, ({ identifier }) =>
                TokenSearchParam.fromQualifiedIdentifier(identifier)
              )
            ),
            _count: SEARCH_COUNT,
          },
        }
        return Match.value(resourceType).pipe(
          Match.when('Patient', (type) =>
            Effect.flatMap(client.Patient.SearchByGet(request), (bundle) => matchesIn(type, bundle))
          ),
          Match.when('Practitioner', (type) =>
            Effect.flatMap(client.Practitioner.SearchByGet(request), (bundle) =>
              matchesIn(type, bundle)
            )
          ),
          Match.exhaustive
        )
      }),
  })

/** The one resource `hits` holds; `None` for no hit, and for two, which is an ambiguous match. */
const theOneOf = (
  hits: readonly LinkableResource.WithId[]
): Option.Option<LinkableResource.WithId> => (hits.length === 1 ? Array.head(hits) : Option.none())

/**
 * Whether `stored` is the stored copy of `referent`'s own decoded resource,
 * under the same literal reference: what a re-import's search finds.
 */
const isStoredCopyOf = (referent: Referent.Type, stored: LinkableResource.WithId): boolean =>
  Referent.match(referent, {
    AsResource: ({ resource }) =>
      LinkableResource.literalReferenceOf(resource) === LinkableResource.literalReferenceOf(stored),
    ByMentionOnly: () => false,
  })

/**
 * The choice the `hits` of one search give `referent`: `UpdateStoredResource`
 * when one is the stored copy of its own decoded resource
 * ({@link isStoredCopyOf}), whatever else was found; else
 * `LinkToStoredResource` to the one hit ({@link theOneOf}); else none.
 */
const choiceAmong = (
  referent: Referent.Type,
  hits: readonly LinkableResource.WithId[]
): Option.Option<LinkChoice.Type> =>
  Array.findFirst(hits, (hit) => isStoredCopyOf(referent, hit)).pipe(
    Option.map((resource): LinkChoice.Type => LinkChoice.UpdateStoredResource({ resource })),
    Option.orElse(() =>
      Option.map(theOneOf(hits), (resource) => LinkChoice.LinkToStoredResource({ resource }))
    )
  )

/**
 * The link choice `referent` takes before the reviewer makes one: the one
 * stored resource of its type that its own identifiers name; when they name
 * none, the one its derived identifier names; else its kind's default
 * (`LinkChoice.defaultFor`). A hit that is the stored copy of the referent's
 * own decoded resource ({@link isStoredCopyOf}) is `UpdateStoredResource`,
 * whatever else the search found, so a re-import writes the newer decode over
 * it, keeping what the copy assumed.
 *
 * @remarks
 * The identifiers a source gave a referent are searched before the one its
 * demographics derive, so a record this source wrote last time is found ahead
 * of another person who shares the name and birth date. Each search asks for
 * two entries, and two hits, neither the referent's own stored copy, are an
 * ambiguous match that picks no default: the reviewer chooses from the stored
 * list. A referent with no searchable identifier takes its default without a
 * request. A failed search fails the read: it is not "no match".
 */
const defaultChoice = (
  referent: Referent.Type
): Effect.Effect<LinkChoice.Type, SearchFailure, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    const { type } = referent.logicalReference
    const namedByOwn = yield* storedNamedBy(type, Referent.ownLogicalReferencesOf(referent))
    const namedByDerived = Array.isEmptyReadonlyArray(namedByOwn)
      ? yield* storedNamedBy(
          type,
          Option.toArray(Referent.maybeDerivedLogicalReferenceOf(referent))
        )
      : []
    return Option.getOrElse(
      Option.orElse(choiceAmong(referent, namedByOwn), () => choiceAmong(referent, namedByDerived)),
      () => LinkChoice.defaultFor(referent)
    )
  })

/**
 * {@link defaultChoice} for every referent of `referents`, a few searches at a
 * time, as the referent link choices a review starts from. The first search to
 * fail fails them all.
 */
const defaultChoices = (
  referents: readonly Referent.Type[]
): Effect.Effect<ReferentLinkChoices.Type, SearchFailure, FhirR4ResourcesHttpApiClient> =>
  Effect.forEach(
    referents,
    (referent) =>
      Effect.map(defaultChoice(referent), (choice) => [Referent.key(referent), choice] as const),
    { concurrency: SEARCH_CONCURRENCY }
  ).pipe(Effect.map(HashMap.fromIterable))

export { defaultChoice, defaultChoices, MatchWithoutResource }
export type { SearchFailure }
