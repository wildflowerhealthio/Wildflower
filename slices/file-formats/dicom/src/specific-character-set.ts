/**
 * DICOM Specific Character Set (0008,0005): which character repertoire a
 * file's text values are written in, and the decode of one value's bytes
 * under it.
 *
 * @packageDocumentation
 */

import { Data, Either } from 'effect'

/**
 * A supported Specific Character Set (0008,0005): the decoder its term names,
 * and the value it was read from.
 *
 * @remarks
 * Only a single-valued (0008,0005) is supported. ISO 2022 code extensions —
 * a multi-valued (0008,0005), or a multi-byte `ISO 2022 IR` term, both of
 * which switch repertoires with escape sequences inside a value — are not.
 */
interface Type {
  /** The (0008,0005) value as the file states it, `undefined` when absent. */
  readonly value: string | undefined
  /**
   * The term {@link decoder} was chosen by, e.g. `ISO_IR 192`. `ISO_IR 6`, the
   * default repertoire, for an absent or empty value.
   */
  readonly term: string
  /** Decodes this repertoire's bytes, throwing on a byte sequence it does not define. */
  readonly decoder: TextDecoder
}

/** Why a file's text cannot be read as its Specific Character Set declares. */
class UndecodableText extends Data.TaggedError('UndecodableText')<{
  readonly reason: string
}> {}

/** The term an absent or empty (0008,0005) stands for: the default repertoire. */
const DEFAULT_REPERTOIRE_TERM = 'ISO_IR 6'

// The single-byte sets PS3.3 C.12.1.1.2 defines, by their number: Table C.12-2
// names each `ISO_IR <n>`, and Table C.12-3 names the same set
// `ISO 2022 IR <n>` for use with code extensions. With one value no extension
// can switch sets, so both terms decode the same way.
//
// Each label is the WHATWG Encoding standard's, which `TextDecoder` resolves.
// Three resolve to a Windows superset rather than the ISO set the term names:
// `latin1` and `iso-8859-9` to windows-1252 and windows-1254, `tis-620` to
// windows-874. Each differs from its ISO set only in 0x80–0x9F, the C1
// control range, which DICOM text never uses.
//
// IR 13 (JIS X 0201) has no WHATWG decoder of its own. shift_jis decodes
// 0xA1–0xDF as the same half-width katakana, and reads 0x5C as `\` and 0x7E as
// `~` rather than yen and overline — which is also how DICOM treats 0x5C.
const SINGLE_BYTE_LABELS: readonly (readonly [number, string])[] = [
  [6, 'latin1'],
  [100, 'latin1'],
  [101, 'iso-8859-2'],
  [109, 'iso-8859-3'],
  [110, 'iso-8859-4'],
  [144, 'iso-8859-5'],
  [127, 'iso-8859-6'],
  [126, 'iso-8859-7'],
  [138, 'iso-8859-8'],
  [148, 'iso-8859-9'],
  [203, 'iso-8859-15'],
  [13, 'shift_jis'],
  [166, 'tis-620'],
]

/**
 * Every supported term, mapped to the `TextDecoder` label for it: the
 * single-byte sets under both their names, plus the multi-byte sets of Table
 * C.12-5 that need no code extensions.
 */
const LABELS: ReadonlyMap<string, string> = new Map([
  ...SINGLE_BYTE_LABELS.flatMap(([number, label]) => [
    [`ISO_IR ${number}`, label] as const,
    [`ISO 2022 IR ${number}`, label] as const,
  ]),
  ['ISO_IR 192', 'utf-8'],
  ['GB18030', 'gb18030'],
  ['GBK', 'gbk'],
])

/** The multi-byte sets of Table C.12-4, which are only reachable through escape sequences. */
const CODE_EXTENSION_TERMS: ReadonlySet<string> = new Set([
  'ISO 2022 IR 87',
  'ISO 2022 IR 159',
  'ISO 2022 IR 149',
  'ISO 2022 IR 58',
])

/** How a reason names a (0008,0005) value. */
const describeValue = (value: string | undefined): string =>
  value === undefined ? 'absent' : `"${value}"`

/** The {@link Type} for a supported value, its decoder made fatal on bytes the set does not define. */
const supportedSet = (value: string | undefined, term: string, label: string): Type => ({
  value,
  term,
  decoder: new TextDecoder(label, { fatal: true }),
})

/** Why a (0008,0005) value is not supported, naming it. */
const unsupportedSet = (value: string, problem: string): UndecodableText =>
  new UndecodableText({
    reason: `SpecificCharacterSet (0008,0005) is ${describeValue(value)}, and ${problem}.`,
  })

/**
 * Read a Specific Character Set (0008,0005) value into the decoder it names.
 *
 * @remarks
 * Terms match exactly after trimming, so a misspelled `ISO_IR100` is an
 * unknown term rather than a guess. An absent or empty value is the default
 * repertoire, decoded as Latin-1 rather than strict ASCII: many older files
 * hold Latin-1 names with no (0008,0005) at all, and ASCII text reads the same
 * either way.
 *
 * @param value - The raw (0008,0005) value, backslash separators and all, or
 *   `undefined` when the file has none
 * @returns The decoder, or an {@link UndecodableText} naming the value when it
 *   is multi-valued, a multi-byte ISO 2022 term or an unknown term
 */
const fromValue = (value: string | undefined): Either.Either<Type, UndecodableText> => {
  if (value === undefined) {
    return Either.right(supportedSet(value, DEFAULT_REPERTOIRE_TERM, 'latin1'))
  }
  const terms = value.split('\\').map((term) => term.trim())
  const term = terms[0] ?? ''
  if (terms.length > 1 || CODE_EXTENSION_TERMS.has(term)) {
    return Either.left(unsupportedSet(value, 'ISO 2022 code extensions are not supported'))
  }
  if (term === '') return Either.right(supportedSet(value, DEFAULT_REPERTOIRE_TERM, 'latin1'))
  const label = LABELS.get(term)
  return label === undefined
    ? Either.left(unsupportedSet(value, 'that is an unknown character set'))
    : Either.right(supportedSet(value, term, label))
}

/** ESC, which opens every ISO 2022 escape sequence. */
const ESCAPE = 0x1b

/**
 * Decodes 0x00–0x7F, on which every supported set agrees. `latin1` is the
 * WHATWG label nearest to ASCII; it reads those bytes as ASCII does.
 */
const asciiDecoder = new TextDecoder('latin1')

/**
 * Decode one text value's bytes under the file's Specific Character Set.
 *
 * @remarks
 * Decode a whole value before splitting it: in GBK or GB18030 a trail byte
 * can be 0x5C (`\`) or 0x5E (`^`), so splitting the bytes first would cut a
 * character in half. A value that is all 0x00–0x7F decodes as ASCII under any
 * set.
 *
 * @param characterSet - The file's Specific Character Set
 * @param bytes - The value's bytes, padding included
 * @param label - How the value's attribute is named in the failure, e.g.
 *   `'PatientName (0010,0010)'`
 * @returns The decoded text, or an {@link UndecodableText} when the bytes hold
 *   an ISO 2022 escape sequence or are not valid in the declared set
 */
const decode = (
  characterSet: Type,
  bytes: Uint8Array,
  label: string
): Either.Either<string, UndecodableText> => {
  const undecodable = (problem: string): UndecodableText =>
    new UndecodableText({
      reason: `${label} cannot be decoded: SpecificCharacterSet (0008,0005) is ${describeValue(characterSet.value)}, and ${problem}.`,
    })
  if (bytes.includes(ESCAPE)) {
    return Either.left(
      undecodable('the value contains ISO 2022 escape sequences, which are not supported')
    )
  }
  if (bytes.every((byte) => byte < 0x80)) return Either.right(asciiDecoder.decode(bytes))
  try {
    return Either.right(characterSet.decoder.decode(bytes))
  } catch (error) {
    if (error instanceof TypeError) {
      return Either.left(undecodable(`the value is not valid ${characterSet.term}`))
    }
    throw error
  }
}

export { decode, fromValue, type Type, UndecodableText }
