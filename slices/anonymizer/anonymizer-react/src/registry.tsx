/* oxlint-disable react/only-export-components ---
  This is the format registry, not a component module: its inline panel
  adapters exist to close a descriptor and its panel over one `T`, and the
  registry values beside them are the exports. Fast Refresh does not apply. */
import { Effect, Either, Schema } from 'effect'
import type { JSX } from 'react'

import {
  DecodeFailure,
  type AnonymizerFormatDescriptor,
  type PickedFile,
} from 'anonymizer-fundamentals'
import { AnonymizePanel } from 'har-anonymizer-react'
import { HttpArchive } from 'har-importer-core/har'

/**
 * The closed format registry: every format the anonymizer shell can identify a
 * picked file as, each descriptor already paired with the panel that reviews
 * its decoded value.
 *
 * @remarks
 * The pairing is a closure, not a lookup: {@link bind} takes a descriptor and a
 * panel over the *same* `T` and returns a {@link BoundFormat} whose
 * `decodeToPanel` runs the decode and hands the value straight to the panel.
 * `T` never escapes, so the shell routes heterogeneous formats without a cast,
 * and a registration whose panel disagrees with its descriptor's type fails to
 * compile.
 *
 * @packageDocumentation
 */

/**
 * One registered format, its value type closed over.
 *
 * @remarks
 * Keeps the descriptor's identification surface (`detect`, `accept`,
 * `display`) at the top level, so the fundamentals' `identify` and `acceptFor`
 * route over registrations directly, while
 * {@link BoundFormat.decodeToPanel} is the only consumer of the decoded value.
 */
interface BoundFormat extends Pick<
  AnonymizerFormatDescriptor<unknown>,
  'format' | 'display' | 'accept' | 'detect'
> {
  /**
   * Decode the picked file and mount this format's panel over the result.
   *
   * @remarks
   * The returned element closes over the decoded value, so one run per pick
   * gives the panel a stable identity to rebuild on — the memo discipline the
   * HAR panel's traps call out.
   */
  readonly decodeToPanel: (file: PickedFile) => Effect.Effect<JSX.Element, DecodeFailure>
}

/** Pairs a descriptor with the panel reviewing its decoded value. */
const bind = <T,>(
  descriptor: AnonymizerFormatDescriptor<T>,
  Panel: (props: { readonly value: T; readonly fileName: string }) => JSX.Element
): BoundFormat => ({
  format: descriptor.format,
  display: descriptor.display,
  accept: descriptor.accept,
  detect: descriptor.detect,
  decodeToPanel: (file) =>
    Effect.map(descriptor.decode(file), (value) => (
      <Panel value={value} fileName={file.fileName} />
    )),
})

/** The alert shown when a picked archive is not decodable HAR. */
const HAR_PARSE_ERROR = 'That archive could not be read as a HAR.'

/** Single decoder, reused per pick. */
const decodeLog = Schema.decodeEither(HttpArchive.LogFromHarJson)

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
    Either.match(decodeLog(new TextDecoder().decode(file.bytes)), {
      onLeft: () => Effect.fail(new DecodeFailure({ message: HAR_PARSE_ERROR })),
      onRight: Effect.succeed,
    }),
}

/**
 * Every registered format, in identification priority order — crisp magic-byte
 * tests belong ahead of looser syntactic ones (a future PDF's `%PDF-` sniff
 * goes before HAR's JSON sniff).
 */
const formatRegistry: readonly BoundFormat[] = [
  bind(harDescriptor, ({ value, fileName }) => <AnonymizePanel log={value} fileName={fileName} />),
]

export { bind, type BoundFormat, formatRegistry, HAR_PARSE_ERROR, harDescriptor }
