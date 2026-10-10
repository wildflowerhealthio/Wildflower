/**
 * Cheap syntactic identification of HAR: either the file name ends in `.har`,
 * or the bytes plausibly hold a top-level JSON object.
 *
 * @remarks
 * The full HAR schema check runs in {@link decodeHar}; the picker calls every
 * registered format's `detect` on every drop, so this must stay a byte-shape
 * sniff rather than a parse. The extension test wins first because a `.har`
 * name is the most common signal; the JSON sniff catches the case a browser
 * exported the archive as plain `.json`. Both tests are the same as
 * `har-anonymizer-core`'s `harDescriptor.detect` by construction — a HAR
 * anonymized and re-imported must be recognized as HAR twice.
 *
 * @packageDocumentation
 */

/**
 * Whether the bytes plausibly hold a JSON object — a cheap first-byte sniff,
 * not a parse. Skips a leading UTF-8 BOM and ASCII whitespace before checking
 * for `{`.
 */
const looksLikeJson = (bytes: Uint8Array): boolean => {
  for (const byte of bytes) {
    if (byte === 0xef || byte === 0xbb || byte === 0xbf) continue
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
    return byte === 0x7b
  }
  return false
}

/**
 * `FileImporter`'s `detect` for HAR: extension `.har`, or JSON-object
 * shape.
 */
const detectHar = (fileBytes: Uint8Array, fileName: string): boolean =>
  fileName.toLowerCase().endsWith('.har') || looksLikeJson(fileBytes)

export { detectHar, looksLikeJson }
