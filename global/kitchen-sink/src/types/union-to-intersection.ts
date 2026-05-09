/**
 * Convert a union `A | B` into an intersection `A & B`.
 *
 * @remarks
 * Distributes the union into a contravariant position; the
 * inferred-from-multiple-candidates rule then picks the intersection.
 * Useful for merging typed callbacks into one overloaded function.
 */
export type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never
