/**
 * Standard union-to-intersection trick. A union in a contravariant
 * position (function argument) inverts to an intersection during
 * inference: TS's distributivity over the union produces a candidate
 * for each member, and the inferred-from-multiple-candidates rule
 * picks the intersection.
 *
 * Useful for merging multiple typed callbacks into a single overloaded
 * function callable with any of their argument unions, among other
 * variance gymnastics.
 */
export type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never
