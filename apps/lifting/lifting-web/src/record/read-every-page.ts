import { Array as Arr, type Effect, Schema } from 'effect'
import {
  type BundleDecodeError,
  fetchAllResourcePages,
  fetchObservationBasedOnOrPartOfPage,
  type ObservationBasedOnOrPartOfFirstPage,
  type ObservationResource,
  type ResourcePage,
  type ResourcePageCycleError,
  type ResourcePageRequestError,
} from 'fhir-r4-react/smart'
import { Observation } from 'fhir-r4/resources'
import { ExerciseSetObservation } from 'lifting-core-js'

import type { SmartClient } from '../smart-client.ts'

/**
 * Reading a lifter's record off the FHIR server: every page of each search,
 * each resource decoded into `lifting-core-js`'s narrowed type, and every
 * resource that did not decode counted rather than dropped in silence.
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

/** Every page of the sets one first page names, over `client`. */
const fetchEveryObservation = (
  client: SmartClient,
  first: ObservationBasedOnOrPartOfFirstPage
): Effect.Effect<Omit<ResourcePage<ObservationResource>, 'nextPageUrl'>, ReadFailure> =>
  fetchAllResourcePages((cursor) => fetchObservationBasedOnOrPartOfPage(client, cursor), first)

/**
 * How many per-resource searches run at once: one per active
 * `ExerciseRequest` (a handful) or per completed workout (a history's worth).
 */
const SEARCH_CONCURRENCY = 4

export {
  decodeEvery,
  type DecodedResources,
  decodeExerciseSetObservations,
  fetchEveryObservation,
  type ReadFailure,
  SEARCH_CONCURRENCY,
}
