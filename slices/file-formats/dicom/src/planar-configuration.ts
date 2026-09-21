/**
 * Planar Configuration (0028,0006): how a colour image's samples are
 * interleaved.
 *
 * @packageDocumentation
 */

/**
 * The enumerated values PS3.3 C.7.6.3.1.3 defines. Only meaningful when
 * Samples per Pixel is greater than one.
 * A `Map`, not an object literal: the value comes from an untrusted file and a
 * `Map` has no inherited keys for it to land on.
 */
const MEANINGS: ReadonlyMap<number, string> = new Map([
  [0, 'colour-by-pixel'],
  [1, 'colour-by-plane'],
])

/**
 * The human-readable meaning of a Planar Configuration value, or `undefined`
 * for a value outside the enumeration.
 */
const meaning = (value: number): string | undefined => MEANINGS.get(value)

export { meaning }
