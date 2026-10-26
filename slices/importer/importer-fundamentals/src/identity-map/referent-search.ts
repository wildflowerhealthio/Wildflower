/**
 * The one server read the identity map needs: a referent's default link
 * choice, found by searching the device for the identifiers the referent
 * answers to.
 *
 * @remarks
 * The search is by identifier only. Demographics are identifiers too
 * (`LinkableResource.maybeDerivedIdentifier`, among a referent's
 * `identifiers`), so a name-and-birth-date match is one more token in the
 * same request.
 *
 * @packageDocumentation
 */

import {
  FhirR4ResourcesHttpApiClient,
  type FhirR4ResourcesHttpApiClientShape,
} from '@wildflowerhealthio/fhir-r4/clients'
import { TokenSearchParam } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Effect, HashMap, Match, Option, pipe } from 'effect'

import * as LinkChoice from './link-choice.ts'
import type * as LinkableLogicalReference from './linkable-logical-reference.ts'
import type * as LinkableResource from './linkable-resource.ts'
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
 * The `identifier` search value for `referent`: every logical reference it
 * answers to (`Referent.logicalReferencesOf`) as a `system|value` token, any
 * of which the server may match. `None` when it answers to none.
 */
const identifierSearchOf = (referent: Referent.Type): Option.Option<string> =>
  pipe(
    Referent.logicalReferencesOf(referent),
    Array.map(({ identifier }) => TokenSearchParam.fromQualifiedIdentifier(identifier)),
    Option.liftPredicate(Array.isNonEmptyReadonlyArray<string>),
    Option.map(TokenSearchParam.anyOf)
  )

/** The first resource a search answered with, if any. */
const firstFound = <TResource>(bundle: {
  readonly entry: readonly { readonly resource: TResource | null }[]
}): Option.Option<TResource> =>
  Array.findFirst(bundle.entry, ({ resource }) => resource !== null).pipe(
    Option.flatMapNullable(({ resource }) => resource)
  )

/** The first resource of `resourceType` on the device that `identifierSearch` names. */
const searchStored = (
  resourceType: LinkableLogicalReference.ResourceType,
  identifierSearch: string
): Effect.Effect<
  Option.Option<LinkableResource.WithId>,
  SearchFailure,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.flatMap(FhirR4ResourcesHttpApiClient, (client) => {
    // Only the first entry is read, so ask for no more than that.
    const request = { urlParams: { identifier: identifierSearch, _count: 1 } }
    return Match.value(resourceType).pipe(
      Match.when('Patient', () =>
        Effect.map(client.Patient.SearchByGet(request), (bundle) => firstFound(bundle))
      ),
      Match.when('Practitioner', () =>
        Effect.map(client.Practitioner.SearchByGet(request), (bundle) => firstFound(bundle))
      ),
      Match.exhaustive
    )
  })

/**
 * The link choice `referent` takes before the reviewer makes one: the first
 * resource of its type on the device that any of its identifiers names, else
 * its kind's default (`LinkChoice.defaultFor`).
 *
 * @remarks
 * One `GET <Type>?identifier=<tokens>&_count=1` per referent, its derived
 * identifier among the tokens, the first entry of the answer winning. A
 * referent with no searchable identifier takes its default without a request.
 * A failed search fails the read: it is not "no match".
 */
const defaultChoice = (
  referent: Referent.Type
): Effect.Effect<LinkChoice.Type, SearchFailure, FhirR4ResourcesHttpApiClient> =>
  Option.match(identifierSearchOf(referent), {
    onNone: () => Effect.succeed(LinkChoice.defaultFor(referent)),
    onSome: (identifierSearch) =>
      Effect.map(searchStored(referent.logicalReference.type, identifierSearch), (found) =>
        Option.match(found, {
          onNone: () => LinkChoice.defaultFor(referent),
          onSome: (resource) => LinkChoice.LinkToStoredResource({ resource }),
        })
      ),
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
