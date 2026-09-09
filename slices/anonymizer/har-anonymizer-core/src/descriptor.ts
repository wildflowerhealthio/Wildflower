import { Effect, Either, Schema } from 'effect'

import { DecodeFailure, type AnonymizerFormatDescriptor } from 'anonymizer-fundamentals'
import { HttpArchive } from 'har-importer-core/har'

/**
 * The HAR format descriptor: identification by extension or JSON shape, and
 * decoding through the shared `HttpArchive.LogFromHarJson` parser.
 *
 * @packageDocumentation
 */

/** The alert shown when a picked archive is not decodable HAR. */
const HAR_PARSE_ERROR = 'That archive could not be read as a HAR.'

/** Single decoder, reused per pick. */
const decodeLog = Schema.decodeEither(HttpArchive.LogFromHarJson)

/** Single UTF-8 decoder, reused per pick. */
const utf8 = new TextDecoder()

/**
 * Whether the bytes plausibly hold a JSON object — a cheap first-byte sniff,
 * not a parse.
 */
const looksLikeJson = (bytes: Uint8Array): boolean => {
  for (const byte of bytes) {
    // Skip UTF-8 BOM bytes and ASCII whitespace before the first real one.
    if (byte === 0xef || byte === 0xbb || byte === 0xbf) continue
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
    return byte === 0x7b // `{`
  }
  return false
}

/** The HAR format: a `.har`-named or JSON-object-shaped file, decoded through the shared parser. */
const harDescriptor: AnonymizerFormatDescriptor<HttpArchive.Log> = {
  format: 'har',
  display: {
    title: 'HTTP Archive',
    description: 'A recorded browsing session, anonymized and downloaded as a .har.',
  },
  accept: ['.har', 'application/json'],
  detect: (file) => file.fileName.toLowerCase().endsWith('.har') || looksLikeJson(file.bytes),
  decode: (file) =>
    Either.match(decodeLog(utf8.decode(file.bytes)), {
      onLeft: () => Effect.fail(new DecodeFailure({ message: HAR_PARSE_ERROR })),
      onRight: Effect.succeed,
    }),
}

export { HAR_PARSE_ERROR, harDescriptor, looksLikeJson }
