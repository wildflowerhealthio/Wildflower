/**
 * UTF-8 without `TextEncoder`: a string's bytes, and its longest prefix that
 * fits a byte budget.
 *
 * @remarks
 * Internal to the package. Hand-written because PebbleKit JS bundles it and the
 * phone's runtime is ES5, which promises no `TextEncoder` (see
 * `fhir-sync-pebble-core-js/pkjs`). It encodes as `TextEncoder` does, a lone
 * surrogate included (as U+FFFD), so `utf8.test.ts` holds it to
 * `kitchen-sink`'s `utf8Bytes`.
 *
 * @packageDocumentation
 */

const isHighSurrogate = (codeUnit: number): boolean => codeUnit >= 0xd800 && codeUnit <= 0xdbff
const isLowSurrogate = (codeUnit: number): boolean => codeUnit >= 0xdc00 && codeUnit <= 0xdfff

/**
 * The code point starting at `index` in `text` and how many UTF-16 code units
 * it takes: 2 for a surrogate pair, else 1. A lone surrogate reads as U+FFFD.
 */
const codePointAt = (
  text: string,
  index: number
): { readonly codePoint: number; readonly codeUnits: number } => {
  const codeUnit = text.charCodeAt(index)
  if (isHighSurrogate(codeUnit) && index + 1 < text.length) {
    const next = text.charCodeAt(index + 1)
    if (isLowSurrogate(next)) {
      return { codePoint: 0x10000 + ((codeUnit - 0xd800) << 10) + (next - 0xdc00), codeUnits: 2 }
    }
  }
  if (isHighSurrogate(codeUnit) || isLowSurrogate(codeUnit)) {
    return { codePoint: 0xfffd, codeUnits: 1 }
  }
  return { codePoint: codeUnit, codeUnits: 1 }
}

/** `codePoint`'s UTF-8 bytes. */
const encodeCodePoint = (codePoint: number): Array<number> => {
  if (codePoint < 0x80) {
    return [codePoint]
  }
  if (codePoint < 0x800) {
    return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)]
  }
  if (codePoint < 0x10000) {
    return [0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)]
  }
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f),
  ]
}

/** `text` as its UTF-8 bytes, a lone surrogate as U+FFFD's. */
const utf8Bytes = (text: string): Array<number> => {
  const bytes: Array<number> = []
  for (let index = 0; index < text.length;) {
    const { codePoint, codeUnits } = codePointAt(text, index)
    const encoded = encodeCodePoint(codePoint)
    for (const byte of encoded) {
      bytes.push(byte)
    }
    index += codeUnits
  }
  return bytes
}

/**
 * The longest prefix of `text` whose UTF-8 takes at most `maxBytes` bytes,
 * cut only between code points: a surrogate pair is kept or dropped whole.
 */
const truncateUtf8 = (text: string, maxBytes: number): string => {
  let byteCount = 0
  let index = 0
  while (index < text.length) {
    const { codePoint, codeUnits } = codePointAt(text, index)
    const codePointBytes = encodeCodePoint(codePoint).length
    if (byteCount + codePointBytes > maxBytes) {
      break
    }
    byteCount += codePointBytes
    index += codeUnits
  }
  return text.slice(0, index)
}

export { truncateUtf8, utf8Bytes }
