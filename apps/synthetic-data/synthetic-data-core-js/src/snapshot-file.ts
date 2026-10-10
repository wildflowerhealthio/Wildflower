import { Order, Schema } from 'effect'

/**
 * A snapshot's entries as the files a static host serves: what each entry,
 * and the header, encodes to (`Snapshot.Entry.FileSchema`,
 * `Snapshot.Header.FileSchema`), and what a reader fetches and decodes back.
 *
 * @remarks
 * This is the encoded side only. A file's `path` is relative to the
 * snapshot's root; the entry it holds, and the path grammar it follows, are
 * the entry's codec's.
 */

/** A text file: JSON, as UTF-8 text. */
const TextSchema = Schema.TaggedStruct('Text', {
  /** Relative to the snapshot's root. */
  path: Schema.String,
  /** Exactly as it is written. */
  text: Schema.String,
}).annotations({ identifier: 'SnapshotTextFile' })

/** A binary file: the bytes of a file an importer read. */
const BytesSchema = Schema.TaggedStruct('Bytes', {
  /** Relative to the snapshot's root. */
  path: Schema.String,
  /** Exactly as they are written. */
  bytes: Schema.Uint8ArrayFromSelf,
}).annotations({ identifier: 'SnapshotBytesFile' })

const AnySchema = Schema.Union(TextSchema, BytesSchema)

type Text = typeof TextSchema.Type

type Bytes = typeof BytesSchema.Type

/** A file of a snapshot, text or bytes. */
type Any = typeof AnySchema.Type

/** A file's text: written with a trailing newline, read with or without one. */
const NewlineTerminatedSchema = Schema.transform(Schema.String, Schema.String, {
  strict: true,
  decode: (text) => (text.endsWith('\n') ? text.slice(0, -1) : text),
  encode: (text) => `${text}\n`,
})

/**
 * A file's text as the JSON `schema` encodes to: written two-space indented
 * with a trailing newline, read from any JSON text.
 */
const jsonTextOf = <A, I, R>(schema: Schema.Schema<A, I, R>): Schema.Schema<A, string, R> =>
  NewlineTerminatedSchema.pipe(Schema.compose(Schema.parseJson(schema, { space: 2 })))

/** A file's text as whatever JSON it holds. */
const JsonTextSchema: Schema.Schema<unknown, string> = jsonTextOf(Schema.Unknown)

/** Whether two files are the same file: one path, and the same text or bytes. */
const same = (left: Any, right: Any): boolean => {
  if (left.path !== right.path) return false
  if (left._tag === 'Text' && right._tag === 'Text') return left.text === right.text
  if (left._tag === 'Bytes' && right._tag === 'Bytes') {
    return (
      left.bytes.length === right.bytes.length &&
      left.bytes.every((byte, index) => byte === right.bytes[index])
    )
  }
  return false
}

/** Files by path, by code unit, so the order is the same in every runtime and locale. */
const byPath: Order.Order<{ readonly path: string }> = Order.mapInput(
  Order.string,
  (file: { readonly path: string }) => file.path
)

export { AnySchema, byPath, BytesSchema, jsonTextOf, JsonTextSchema, same, TextSchema }
export type { Any, Bytes, Text }
