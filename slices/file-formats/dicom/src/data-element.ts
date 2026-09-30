/**
 * One top-level data element of a Part 10 file as {@link Part10} reads and
 * writes it: its tag, its VR and its value bytes, uninterpreted.
 *
 * @packageDocumentation
 */

/** See the module summary. */
interface Type {
  /** `(group << 16) | element`, so numeric order is the order a data set is written in. */
  readonly tag: number
  /** The two-letter value representation, as written. */
  readonly vr: string
  /**
   * The value as written, padding included. For an undefined-length element,
   * everything after its header up to and including its Sequence Delimitation
   * Item.
   */
  readonly value: Uint8Array
  /** Written with length `0xFFFFFFFF`, and delimited rather than counted. */
  readonly undefinedLength: boolean
}

/** Whether an element's group is odd — a private data element (PS3.5 7.8). */
const isPrivate = (element: Type): boolean => (element.tag >>> 16) % 2 === 1

/** Ascending tag order, the order PS3.5 7.1 writes a data set in. */
const byTag = (left: Type, right: Type): number => left.tag - right.tag

/** A tag in the `(gggg,eeee)` form the standard writes it in. */
const tagLabelOf = (tag: number): string => {
  const hex = tag.toString(16).toUpperCase().padStart(8, '0')
  return `(${hex.slice(0, 4)},${hex.slice(4)})`
}

export { byTag, isPrivate, tagLabelOf }
export type { Type }
