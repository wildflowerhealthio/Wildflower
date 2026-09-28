import type { DateTime } from 'effect'

/** A closed time interval, `[start, end]`, with `start <= end`. */
type TimeDomain = readonly [DateTime.Utc, DateTime.Utc]

/** Whether the instant `epochMillis` lies inside `domain`, endpoints included. */
const contains = (domain: TimeDomain, epochMillis: number): boolean =>
  epochMillis >= domain[0].epochMillis && epochMillis <= domain[1].epochMillis

/** The points inside `domain`, endpoints included, in input order. */
const pointsWithin = <A extends { readonly time: DateTime.Utc }>(
  points: readonly A[],
  domain: TimeDomain
): readonly A[] => points.filter((point) => contains(domain, point.time.epochMillis))

export { contains, pointsWithin }
export type { TimeDomain }
