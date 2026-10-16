import type { SpanSeries } from '@wildflowerhealthio/plots-fundamentals'

/**
 * Pebble HealthService's code system, as a series key holds it: FHIR Sync for
 * Pebble's `HEALTH_SERVICE_SYSTEM` with its trailing slash dropped, the way
 * every coding system is compared here.
 */
const HEALTH_SERVICE_SYSTEM =
  'https://developer.repebble.com/docs/c/Foundation/Event_Service/HealthService'

/**
 * FHIR Sync for Pebble's activity value codes, in lane-colour order: each
 * takes the `SpanSeries` colour slot of its index, so an activity wears the
 * same colour in every record.
 *
 * @remarks
 * The order is the palette's validated adjacency: the pairs that sit side by
 * side in a lane — sleeping and restful sleeping, walking and running,
 * running and an open workout — are the neighbours the palette separates.
 * `observation-span-series.test.ts` reads each code from FHIR Sync for
 * Pebble's own writer, so a renamed code fails there rather than turning grey
 * here.
 */
const ACTIVITY_CODES_IN_COLOUR_ORDER: readonly string[] = [
  'HealthActivitySleep',
  'HealthActivityRestfulSleep',
  'HealthActivityWalk',
  'HealthActivityRun',
  'HealthActivityOpenWorkout',
]

/**
 * The span category a coded value names: an opaque id from its system and
 * code, the `label` the caller read for it, and the lane colour slot it keeps
 * — one of the Pebble activities' own, or `null` (neutral) for any other code.
 */
const spanCategoryOf = (
  value: { readonly system: string | null; readonly code: string },
  label: string
): SpanSeries.SpanCategory => {
  const activityIndex =
    value.system === HEALTH_SERVICE_SYSTEM ? ACTIVITY_CODES_IN_COLOUR_ORDER.indexOf(value.code) : -1
  return {
    id: JSON.stringify([value.system, value.code]),
    label,
    colourSlot: activityIndex === -1 ? null : activityIndex,
  }
}

export { spanCategoryOf }
