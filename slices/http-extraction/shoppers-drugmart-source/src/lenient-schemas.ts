import { Array as Arr, Option, Schema } from 'effect'

/**
 * Lenient building blocks for the portal's payload schemas: a list whose
 * entries decode one by one, and a field that reads as absent when it does
 * not decode.
 *
 * @remarks
 * Both declare their encoded side as the inner schema's `Encoded`, so a
 * producer typing its bodies as a payload's `.Encoded` is held to the shape
 * the portal writes. That side is declared, not checked: the decode that
 * follows checks each entry or field against the inner schema, which is what
 * lets a malformed one be dropped rather than fail the payload.
 */

/** `I` as a schema that accepts any input, for a slot whose decode checks it. */
const declaredAs = <I>(): Schema.Schema<I> => Schema.declare((_: unknown): _ is I => true)

/**
 * A list's entries once each has been decoded on its own: those that decoded,
 * in order, and how many did not.
 */
interface DecodedEntries<A> {
  /** The entries that decoded, in list order. */
  readonly decoded: ReadonlyArray<A>
  /** How many entries did not decode, and so are not in {@link decoded}. */
  readonly undecodable: number
}

/**
 * A JSON array of `entry`s, decoded entry by entry: one that does not decode
 * is counted in `undecodable` rather than failing the array. A value that is
 * not an array still fails.
 *
 * @param entry - The schema each entry decodes through
 * @param entriesIn - Reads the entries out of the raw array before decoding;
 *   by default the array's own elements
 */
const DecodableEntries = <A, I>(
  entry: Schema.Schema<A, I>,
  entriesIn: (raw: ReadonlyArray<unknown>) => ReadonlyArray<unknown> = (raw) => raw
): Schema.Schema<DecodedEntries<A>, ReadonlyArray<I>> => {
  const decodeEntry = Schema.decodeUnknownOption(entry)
  const encodeEntry = Schema.encodeSync(entry)
  return Schema.transform(
    Schema.Array(declaredAs<I>()),
    Schema.Struct({
      decoded: Schema.Array(Schema.typeSchema(entry)),
      undecodable: Schema.Number,
    }),
    {
      strict: true,
      decode: (raw) => {
        const entries = entriesIn(raw)
        const decoded = Arr.filterMap(entries, (rawEntry) => decodeEntry(rawEntry))
        return { decoded, undecodable: entries.length - decoded.length }
      },
      encode: ({ decoded }) => decoded.map((decodedEntry) => encodeEntry(decodedEntry)),
    }
  )
}

/**
 * An optional field that reads as absent when it is `null` or does not decode
 * through `schema` (a phone number sent as a number, say), so one malformed
 * field never costs the record that carries it.
 *
 * @param schema - The schema the field's value decodes through
 */
const MalformedAsAbsent = <A, I>(
  schema: Schema.Schema<A, I>
): Schema.PropertySignature<'?:', A, never, '?:', I | null, false> => {
  const decodeValue = Schema.decodeUnknownOption(schema)
  const encodeValue = Schema.encodeSync(schema)
  return Schema.optionalToOptional(declaredAs<I | null>(), Schema.typeSchema(schema), {
    decode: Option.flatMap(decodeValue),
    encode: Option.map(encodeValue),
  })
}

export { DecodableEntries, type DecodedEntries, MalformedAsAbsent }
