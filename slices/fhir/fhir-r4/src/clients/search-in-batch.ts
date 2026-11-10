import { UrlParams } from '@effect/platform'
import { Array, Data, Effect, type Either, type ParseResult, Schema } from 'effect'

import * as Bundle from '../data-types/resources/bundle.ts'
import { FhirResourceSchema, type FhirResourceWithId, hasId } from '../resources/index.ts'
import { batchOfGets } from './batch-of-gets.ts'
import {
  FhirR4ResourcesHttpApiClient,
  type FhirR4ResourcesClientShape,
} from './fhir-r4-resources-http-api-client.ts'
import { NO_RESPONSE_STATUS, statusOk } from './persist-batch-bundle.ts'
import {
  type SearchableResourceType,
  type SearchParamsByType,
  searchesByType,
} from './search-by-type.ts'
import { matchesIn, type MatchWithoutResource } from './search-pages.ts'

/**
 * Several searches in one round trip: a FHIR `POST /` `batch` Bundle whose
 * entries are each a `GET <Type>?<query>`, every entry answering with its own
 * searchset.
 *
 * @packageDocumentation
 */

/** One search of a batch: a searchable resource type and its search parameters. */
type BatchSearch = {
  readonly [ResourceType in SearchableResourceType]: {
    readonly resourceType: ResourceType
    readonly urlParams: SearchParamsByType[ResourceType]
  }
}[SearchableResourceType]

/**
 * A search of a batch the server answered with a non-2xx status, or did not
 * answer at all ({@link NO_RESPONSE_STATUS}, when the response bundle holds no
 * entry for it): not "no match", since nothing says what it would have found.
 */
class BatchSearchRejected extends Data.TaggedError('BatchSearchRejected')<{
  /** The resource type the search was for. */
  readonly resourceType: SearchableResourceType
  /** The entry's echoed status, `"NNN Text"`, or {@link NO_RESPONSE_STATUS}. */
  readonly status: string
  /** The OperationOutcome the server gave for the entry, when it gave one. */
  readonly outcome: Bundle.OperationOutcomeType | null
}> {}

/**
 * What one search of a batch can fail with: the server rejected it
 * ({@link BatchSearchRejected}), its answer is not a searchset of stored
 * resources (a `ParseError`), or a match carries no resource
 * ({@link MatchWithoutResource}).
 */
type BatchSearchFailure = BatchSearchRejected | ParseResult.ParseError | MatchWithoutResource

/** What submitting the batch can fail with: the typed client's own failures for `POST /`. */
type BatchSubmitFailure = Effect.Effect.Error<
  ReturnType<FhirR4ResourcesClientShape['Bundle']['Submit']>
>

/** A stored resource: a supported resource with its `id`, as a search answers with it. */
const StoredResourceSchema = FhirResourceSchema.pipe(
  Schema.filter((resource): resource is FhirResourceWithId => hasId(resource), {
    message: () => 'a stored resource has an id',
  })
)

/**
 * A searchset of stored resources: what a search entry's `resource` holds.
 *
 * @remarks
 * Decoded here rather than by the endpoint, whose entry `resource` is
 * `Schema.Any` (see `http-api-definition/bundle.ts`).
 */
const SearchsetSchema = Bundle.Schema(StoredResourceSchema)

/**
 * `search` as a batch entry's `request.url`: `<Type>?<query>`, the query its
 * search parameters as the typed client encodes them, URL-encoded.
 */
const searchUrlOf = <ResourceType extends SearchableResourceType>(search: {
  readonly resourceType: ResourceType
  readonly urlParams: SearchParamsByType[ResourceType]
}): Effect.Effect<string, ParseResult.ParseError> =>
  Effect.map(
    Schema.encode(searchesByType[search.resourceType].searchParams)(search.urlParams),
    (encoded) => `${search.resourceType}?${UrlParams.toString(UrlParams.fromInput(encoded))}`
  )

/** One entry of a batch-response: a search's answer. */
type ResponseEntry = Bundle.BundleValue<unknown>['entry'][number]

/**
 * The stored resources of `resourceType` a search's answer matched: its
 * entry's searchset, when the entry's status is a 2xx, its matches read by
 * `matchesIn`.
 */
const matchesOfEntry = (
  resourceType: SearchableResourceType,
  entry: ResponseEntry | undefined
): Effect.Effect<readonly FhirResourceWithId[], BatchSearchFailure> => {
  if (entry === undefined || entry.response === null) {
    return Effect.fail(
      new BatchSearchRejected({ resourceType, status: NO_RESPONSE_STATUS, outcome: null })
    )
  }
  const { status, outcome } = entry.response
  if (!statusOk(status)) {
    return Effect.fail(new BatchSearchRejected({ resourceType, status, outcome: outcome ?? null }))
  }
  return Effect.flatMap(Schema.decodeUnknown(SearchsetSchema)(entry.resource), (searchset) =>
    matchesIn(resourceType, searchset)
  )
}

/**
 * Run `searches` as one `POST /` `batch` Bundle, one `GET <Type>?<query>`
 * entry each, and give each search's matches, or its failure, at its position.
 *
 * @remarks
 * Each search answers with its first page, sized by its own `_count`: the
 * `next` link of a searchset is not followed. A search the server rejects
 * fails as {@link BatchSearchRejected} at its position while the others keep
 * their matches; a search whose parameters do not encode, or a failure to
 * submit the batch at all, fails the whole call.
 * Nothing is submitted for no searches.
 *
 * @param searches - The searches, in the order their answers are given
 * @returns Each search's matches, or its {@link BatchSearchFailure}, in the
 *   order of `searches`
 */
const searchInBatch = (
  searches: readonly BatchSearch[]
): Effect.Effect<
  readonly Either.Either<readonly FhirResourceWithId[], BatchSearchFailure>[],
  BatchSubmitFailure | ParseResult.ParseError,
  FhirR4ResourcesHttpApiClient
> =>
  Array.match(searches, {
    onEmpty: () => Effect.succeed([]),
    onNonEmpty: (submitted) =>
      Effect.gen(function* () {
        const client = yield* FhirR4ResourcesHttpApiClient
        const urls = yield* Effect.forEach(submitted, searchUrlOf)
        const response = yield* client.Bundle.Submit({ payload: batchOfGets(urls) })
        // FHIR R4 § 3.2.5.2: a batch-response holds one entry per request
        // entry, in the same order.
        return yield* Effect.forEach(submitted, (search, index) =>
          Effect.either(matchesOfEntry(search.resourceType, response.entry[index]))
        )
      }),
  })

export { BatchSearchRejected, searchInBatch }
export type { BatchSearch, BatchSearchFailure, BatchSubmitFailure }
