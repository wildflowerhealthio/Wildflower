/**
 * Pixel Representation (0028,0103): how a sample's bits are read as a number.
 *
 * @packageDocumentation
 */

/**
 * The enumerated values PS3.3 C.7.6.3.1.5 defines.
 *
 * @remarks
 * A `Map` rather than an object literal: the value is read straight out of an
 * untrusted file, and a `Map` has no inherited keys for it to land on.
 */
const MEANINGS: ReadonlyMap<number, string> = new Map([
  [0, 'unsigned'],
  [1, 'signed (two’s complement)'],
])

/**
 * The human-readable meaning of a Pixel Representation value, or `undefined`
 * for a value outside the enumeration.
 */
const meaning = (value: number): string | undefined => MEANINGS.get(value)

export { meaning }
