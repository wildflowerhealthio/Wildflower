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
import { Array, Effect, HashMap, Match, Option } from 'effect'

import * as LinkChoice from './link-choice.ts'
import type * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as LinkableResource from './linkable-resource.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import * as Referent from './referent.ts'

/**
 * What a search can fail with: the typed client's own failures, the same for
 * every resource type's search.
 */
type SearchFailure = Effect.Effect.Error<
  ReturnType<FhirR4ResourcesHttpApiClientShape['Patient']['SearchByGet']>
>

/** How many referents {@link defaultChoices} searches for at once. */
const SEARCH_CONCURRENCY = 4

/**
 * How many entries a search asks for: one more than it links to, so a second
 * hit reads as an ambiguous match rather than going unseen.
 */
const SEARCH_COUNT = 2

/** The stored resources a search answered with. */
const foundIn = <TResource>(bundle: {
  readonly entry: readonly { readonly resource: TResource | null }[]
}): readonly TResource[] =>
  Array.filterMap(bundle.entry, ({ resource }) => Option.fromNullable(resource))

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
          Match.when('Patient', () => Effect.map(client.Patient.SearchByGet(request), foundIn)),
          Match.when('Practitioner', () =>
            Effect.map(client.Practitioner.SearchByGet(request), foundIn)
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
 * The link choice `referent` takes before the reviewer makes one: the one
 * stored resource of its type that its own identifiers name; when they name
 * none, the one its derived identifier names; else its kind's default
 * (`LinkChoice.defaultFor`). A hit that is the stored copy of the referent's
 * own decoded resource ({@link isStoredCopyOf}) is `CreateResource`, so a
 * re-import writes the newer decode over it.
 *
 * @remarks
 * The identifiers a source gave a referent are searched before the one its
 * demographics derive, so a record this source wrote last time is found ahead
 * of another person who shares the name and birth date. Each search asks for
 * two entries, and two hits are an ambiguous match that picks no default: the
 * reviewer chooses from the stored list. A referent with no searchable
 * identifier takes its default without a request. A failed search fails the
 * read: it is not "no match".
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
    return Option.match(
      Option.orElse(theOneOf(namedByOwn), () => theOneOf(namedByDerived)),
      {
        onNone: () => LinkChoice.defaultFor(referent),
        onSome: (resource) =>
          isStoredCopyOf(referent, resource)
            ? LinkChoice.CreateResource()
            : LinkChoice.LinkToStoredResource({ resource }),
      }
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

export { defaultChoice, defaultChoices }
export type { SearchFailure }
