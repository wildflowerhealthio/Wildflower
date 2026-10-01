import { Array as Arr, Effect, Schema } from 'effect'
import {
  type BundleDecodeError,
  fetchAllResourcePages,
  fetchObservationBasedOnOrPartOfPage,
  type ObservationBasedOnOrPartOfFirstPage,
  type ObservationResource,
  type ResourcePage,
  type ResourcePageCursor,
  type ResourcePageCycleError,
  type ResourcePageRequestError,
} from 'fhir-r4-react/smart'
import { Observation } from 'fhir-r4/resources'
import { ExerciseSetObservation } from 'lifting-core'

import type { SmartClient } from '../smart-client.ts'

/**
 * Reading a lifter's record off the FHIR server: every page of each search,
 * each resource decoded into `lifting-core`'s narrowed type, and every
 * resource that did not decode counted rather than dropped in silence. Every
 * page request over one client shares one cap, {@link SEARCH_CONCURRENCY}.
 *
 * @packageDocumentation
 */

/** A failed read: a page request, a page that is not a bundle, or a `next` link that loops. */
type ReadFailure = ResourcePageRequestError | BundleDecodeError | ResourcePageCycleError

/** The resources a whole read decoded as the lifting type, and how many it could not. */
interface DecodedResources<A> {
  readonly resources: readonly A[]
  readonly unreadableCount: number
}

/**
 * Decode every resource of a whole read through a lifting `Schema`, counting
 * the page entries that did not decode as FHIR beside the resources the
 * schema refused.
 */
const decodeEvery = <A, I>(
  schema: Schema.Schema<A, I>,
  read: Omit<ResourcePage<I>, 'nextPageUrl'>
): DecodedResources<A> => {
  const decode = Schema.decodeEither(schema)
  const [refused, resources] = Arr.partitionMap(read.items, (item) => decode(item))
  return { resources, unreadableCount: refused.length + read.droppedEntryCount }
}

/**
 * The sets of a whole `Observation` read: retracted observations left out
 * before decoding — withdrawn, not unreadable — and the rest decoded as
 * {@link decodeEvery} decodes.
 */
const decodeExerciseSetObservations = (
  read: Omit<ResourcePage<ObservationResource>, 'nextPageUrl'>
): DecodedResources<ExerciseSetObservation.Type> =>
  decodeEvery(ExerciseSetObservation.Schema, {
    ...read,
    items: read.items.filter(
      (observation) => !Observation.RETRACTED_STATUSES.has(observation.status)
    ),
  })

/**
 * How many page requests the reads over one client hold in flight at once,
 * across every search they run side by side — the training record's, the
 * history's, and every page each search follows.
 */
const SEARCH_CONCURRENCY = 4

/** Each client's permits: one per page request in flight, {@link SEARCH_CONCURRENCY} in all. */
const requestPermitsByClient = new WeakMap<SmartClient, Effect.Semaphore>()

const requestPermitsOf = (client: SmartClient): Effect.Semaphore => {
  const known = requestPermitsByClient.get(client)
  if (known !== undefined) return known
  const permits = Effect.unsafeMakeSemaphore(SEARCH_CONCURRENCY)
  requestPermitsByClient.set(client, permits)
  return permits
}

/**
 * Every page of a search over `client`, each page request holding one of the
 * client's permits while it is in flight — so reads may fan out as wide as
 * they like and the server still sees at most {@link SEARCH_CONCURRENCY}
 * requests at once.
 */
const fetchEveryPage = <A, First, E>(
  client: SmartClient,
  fetchPage: (
    client: SmartClient,
    cursor: ResourcePageCursor<First>
  ) => Effect.Effect<ResourcePage<A>, E>,
  first: First
): Effect.Effect<Omit<ResourcePage<A>, 'nextPageUrl'>, E | ResourcePageCycleError> =>
  fetchAllResourcePages(
    (cursor) => requestPermitsOf(client).withPermits(1)(fetchPage(client, cursor)),
    first
  )

/** Every page of the sets one first page names, over `client`. */
const fetchEveryObservation = (
  client: SmartClient,
  first: ObservationBasedOnOrPartOfFirstPage
): Effect.Effect<Omit<ResourcePage<ObservationResource>, 'nextPageUrl'>, ReadFailure> =>
  fetchEveryPage(client, fetchObservationBasedOnOrPartOfPage, first)

export {
  decodeEvery,
  type DecodedResources,
  decodeExerciseSetObservations,
  fetchEveryObservation,
  fetchEveryPage,
  type ReadFailure,
  SEARCH_CONCURRENCY,
}
