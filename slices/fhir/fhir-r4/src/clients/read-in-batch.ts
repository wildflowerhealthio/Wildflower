import { Array, Data, Effect, Option, type ParseResult, Schema } from 'effect'

import type * as Bundle from '../data-types/resources/bundle.ts'
import { type FhirResourceWithId, StoredResourceSchema } from '../resources/index.ts'
import { batchOfGets } from './batch-of-gets.ts'
import { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'
import { NO_RESPONSE_STATUS, statusOk } from './persist-batch-bundle.ts'
import type { BatchSubmitFailure } from './search-in-batch.ts'

/**
 * Several reads in one round trip: a FHIR `POST /` `batch` Bundle whose
 * entries are each a `GET <Type>/<id>`.
 *
 * @packageDocumentation
 */

/**
 * A read of a batch the server answered with a status other than a `2xx`, a
 * `404` or a `410`, or did not answer at all ({@link NO_RESPONSE_STATUS}):
 * not "nothing stored", since nothing says what is.
 */
class BatchReadRejected extends Data.TaggedError('BatchReadRejected')<{
  /** The literal reference read, `<Type>/<id>`. */
  readonly literalReference: string
  /** The entry's echoed status, `"NNN Text"`, or {@link NO_RESPONSE_STATUS}. */
  readonly status: string
}> {}

/** The statuses that say nothing is stored under a literal reference: `404 Not Found` and `410 Gone`. */
const NOTHING_STORED_CODES: ReadonlySet<number> = new Set([404, 410])

/** One entry of a batch-response: a read's answer. */
type ResponseEntry = Bundle.BundleValue<unknown>['entry'][number]

/**
 * The stored resource a read's answer holds: `None` for a `404` or a `410`,
 * the entry's resource decoded as a stored resource for a `2xx`, and
 * {@link BatchReadRejected} for any other status or no answer.
 */
const storedResourceOfEntry = (
  literalReference: string,
  entry: ResponseEntry | undefined
): Effect.Effect<Option.Option<FhirResourceWithId>, BatchReadRejected | ParseResult.ParseError> => {
  const status = entry?.response?.status ?? NO_RESPONSE_STATUS
  if (NOTHING_STORED_CODES.has(Number.parseInt(status, 10))) return Effect.succeed(Option.none())
  if (!statusOk(status)) return Effect.fail(new BatchReadRejected({ literalReference, status }))
  return Effect.map(
    Schema.decodeUnknown(StoredResourceSchema)(entry?.resource),
    Option.some<FhirResourceWithId>
  )
}

/**
 * Read each of `literalReferences` as one `POST /` `batch` Bundle, one
 * `GET <Type>/<id>` entry each, and give the resource stored under each, at
 * its position.
 *
 * @remarks
 * A read the server answers `404` or `410` has nothing stored. Any other
 * failed read, an answer that does not decode as a stored resource, or a
 * failure to submit the batch fails the whole call. Nothing is submitted for
 * no reads.
 *
 * @param literalReferences - The reads, `<Type>/<id>` each, in the order
 *   their answers are given
 * @returns The resource stored under each, `None` where nothing is
 */
const readInBatch = (
  literalReferences: readonly string[]
): Effect.Effect<
  readonly Option.Option<FhirResourceWithId>[],
  BatchSubmitFailure | BatchReadRejected | ParseResult.ParseError,
  FhirR4ResourcesHttpApiClient
> =>
  Array.match(literalReferences, {
    onEmpty: () => Effect.succeed([]),
    onNonEmpty: (read) =>
      Effect.gen(function* () {
        const client = yield* FhirR4ResourcesHttpApiClient
        const response = yield* client.Bundle.Submit({ payload: batchOfGets(read) })
        // FHIR R4 § 3.2.5.2: a batch-response holds one entry per request
        // entry, in the same order.
        return yield* Effect.forEach(read, (literalReference, index) =>
          storedResourceOfEntry(literalReference, response.entry[index])
        )
      }),
  })

export { BatchReadRejected, readInBatch }
