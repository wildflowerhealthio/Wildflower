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
  matchesIn,
  type MatchWithoutResource,
} from '@wildflowerhealthio/fhir-r4/clients'
import { TokenSearchParam } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Effect, HashMap, Match, Option } from 'effect'

import * as LinkChoice from './link-choice.ts'
import type * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as ReferentLinkChoiceSet from './referent-link-choice-set.ts'
import * as Referent from './referent.ts'

/**
 * What a search can fail with: the typed client's own failures, the same for
 * every resource type's search, and a match that carries no resource
 * (`fhir-r4/clients`' `matchesIn`).
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

/**
 * The stored resources of `resourceType` that any of `logicalReferences`
 * names, up to {@link SEARCH_COUNT}: one `GET <Type>?identifier=<tokens>`,
 * or none, and nothing, when there is no reference to search by. The hits
 * are the searchset's matches (`matchesIn`): a match without its resource
 * fails the search rather than going uncounted, since the count is what
 * tells one hit from an ambiguous match.
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
              Array.map(named, ({ identifier: [identifier] }) =>
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
  LinkableResource.sameRecord(referent.resource, stored)

/**
 * The choice `referent` takes over `storedCopy`, the stored copy of its own
 * resource: `UpdateStoredResource`, so a re-import writes the newer decode
 * over it; but `LinkToStoredResource` for a record the import implied (its
 * `origin`), which holds only what a reference said of it and would write
 * over everything else the copy holds.
 */
const storedCopyChoiceOf = (
  referent: Referent.Type,
  storedCopy: LinkableResource.WithId
): LinkChoice.Type =>
  Match.value(referent.origin).pipe(
    Match.when('Decoded', () => LinkChoice.UpdateStoredResource({ resource: storedCopy })),
    Match.when('Implied', () => LinkChoice.LinkToStoredResource({ resource: storedCopy })),
    Match.exhaustive
  )

/**
 * The choice the `hits` of one search give `referent`: the one over the
 * stored copy of its own resource ({@link isStoredCopyOf},
 * {@link storedCopyChoiceOf}), whatever else was found; else
 * `LinkToStoredResource` to the one hit ({@link theOneOf}); else none.
 */
const choiceAmong = (
  referent: Referent.Type,
  hits: readonly LinkableResource.WithId[]
): Option.Option<LinkChoice.Type> =>
  Array.findFirst(hits, (resource): Option.Option<LinkChoice.Type> =>
    Option.liftPredicate(storedCopyChoiceOf(referent, resource), () =>
      isStoredCopyOf(referent, resource)
    )
  ).pipe(
    Option.orElse(() =>
      Option.map(theOneOf(hits), (resource) => LinkChoice.LinkToStoredResource({ resource }))
    )
  )

/**
 * The link choice `referent` takes before the reviewer makes one: the one
 * stored resource of its type that its own identifiers name; when they name
 * none, the one its derived identifier names; else the default
 * (`ReferentLinkChoiceSet.DEFAULT_CHOICE`). A hit that is the stored copy of
 * the referent's own decoded resource ({@link isStoredCopyOf}) is `UpdateStoredResource`,
 * whatever else the search found, so a re-import writes the newer decode over
 * it, keeping what the copy assumed; for an implied record it is
 * `LinkToStoredResource`, keeping the copy ({@link storedCopyChoiceOf}).
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
    const { resourceType } = referent.logicalReference
    const namedByOwn = yield* storedNamedBy(resourceType, Referent.ownLogicalReferencesOf(referent))
    const namedByDerived = Array.isEmptyReadonlyArray(namedByOwn)
      ? yield* storedNamedBy(
          resourceType,
          Option.toArray(Referent.maybeDerivedLogicalReferenceOf(referent))
        )
      : []
    return Option.getOrElse(
      Option.orElse(choiceAmong(referent, namedByOwn), () => choiceAmong(referent, namedByDerived)),
      () => ReferentLinkChoiceSet.DEFAULT_CHOICE
    )
  })

/**
 * {@link defaultChoice} for every referent of `referents`, a few searches at a
 * time, as the referent link choices a review starts from. The first search to
 * fail fails them all.
 */
const defaultChoices = (
  referents: readonly Referent.Type[]
): Effect.Effect<ReferentLinkChoiceSet.Type, SearchFailure, FhirR4ResourcesHttpApiClient> =>
  Effect.forEach(
    referents,
    (referent) =>
      Effect.map(defaultChoice(referent), (choice) => [Referent.key(referent), choice] as const),
    { concurrency: SEARCH_CONCURRENCY }
  ).pipe(Effect.map(HashMap.fromIterable))

export { defaultChoice, defaultChoices }
export type { SearchFailure }
