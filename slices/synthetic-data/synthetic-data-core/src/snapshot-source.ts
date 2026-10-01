import { Data, Effect, ParseResult, Schema } from 'effect'
import { sha256Base64 } from 'importer-fundamentals'

import * as Entry from './snapshot-entry.ts'
import * as Header from './snapshot-header.ts'

/**
 * Reading a published snapshot back: its header, and each resource entry as
 * the import wrote it, fetched through a {@link Source} the caller supplies.
 *
 * @remarks
 * A reader decodes each file with its entry's codec, so a resource file must
 * hold the resource its path names, and checks what the codec cannot: that a
 * source-file `DocumentReference` links its file where the snapshot puts it
 * (and no other resource links one), and that the linked file is the one its attachment describes (its `size`
 * and `hash`, base64 SHA-256). Only then is the file carried inline again
 * (`Entry.withAttachmentData`). Every failure is an {@link UnreadableFile}
 * naming the file at fault.
 */

/** A snapshot's file that cannot be read back, and why. */
class UnreadableFile extends Data.TaggedError('UnreadableFile')<{
  /** The file's path, relative to the snapshot's root. */
  readonly path: string
  readonly reason: string
}> {
  /** `<path>: <reason>`, the line a reader shows. */
  override get message(): string {
    return `${this.path}: ${this.reason}`
  }
}

/**
 * Where a reader fetches a snapshot's files: each by its path relative to the
 * snapshot's root, as text (`index.json`, a resource's file) or as bytes (an
 * attachment's file). A file that cannot be fetched fails as an
 * {@link UnreadableFile}.
 */
interface Source {
  readonly text: (path: string) => Effect.Effect<string, UnreadableFile>
  readonly bytes: (path: string) => Effect.Effect<Uint8Array, UnreadableFile>
}

/** `error`'s issues, as one line a reader can show. */
const reasonOf = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`
    )
    .join('; ')

/** An {@link UnreadableFile} at `path` for a file its schema does not decode. */
const unreadableAt =
  (path: string) =>
  (error: ParseResult.ParseError): UnreadableFile =>
    new UnreadableFile({ path, reason: reasonOf(error) })

const decodeHeaderFile = Schema.decodeUnknown(Header.FileSchema)

/**
 * The snapshot's header, decoded from `index.json`: its members and the paths
 * of their entries, every path already in the entries' grammar.
 *
 * @returns The header; an {@link UnreadableFile} for an `index.json` that
 *   cannot be fetched or is not a valid header
 */
const readHeader = (source: Source): Effect.Effect<Header.Header, UnreadableFile> =>
  source
    .text(Header.PATH)
    .pipe(
      Effect.flatMap((text) =>
        decodeHeaderFile({ _tag: 'Text', path: Header.PATH, text }).pipe(
          Effect.mapError(unreadableAt(Header.PATH))
        )
      )
    )

/**
 * Why a resource entry is not one a published snapshot holds, or `true` when
 * it is: a source-file `DocumentReference` of one of
 * `Entry.SOURCE_FILE_IMPORTERS` links its file at `<format>/<title>`, where
 * the layout put it, and no other resource links a file.
 */
const linksItsSourceFile = ({ resource, attachmentPath }: Entry.Resource): true | string => {
  if (resource.resourceType !== 'DocumentReference') return true
  const format = Entry.formatOf(resource)
  if (format === undefined) {
    return (
      attachmentPath === undefined ||
      `It is not a ${Entry.FORMATS.join(' or ')} source file, and links ${attachmentPath}.`
    )
  }
  const [content, ...otherContent] = resource.content
  const title = otherContent.length === 0 ? (content?.attachment.title ?? null) : null
  const expected = title === null ? undefined : Entry.attachmentPathOf(format, title)
  if (expected !== undefined && attachmentPath === expected) return true
  const linked = attachmentPath === undefined ? 'links no file' : `links ${attachmentPath}`
  return expected === undefined
    ? `It is a ${format} source file with no one attachment titled for a file, and ${linked}.`
    : `It is a ${format} source file, and ${linked}, not ${expected}.`
}

/**
 * A resource's file ⇄ its entry, as a published snapshot holds it:
 * `Entry.ResourceFileSchema`, and a source file linking its file where the
 * layout put it.
 */
const PublishedResourceFileSchema = Entry.ResourceFileSchema.pipe(Schema.filter(linksItsSourceFile))

const decodeResourcePath = Schema.decodeUnknown(Entry.ResourcePathSchema)

const decodeResourceFile = Schema.decodeUnknown(PublishedResourceFileSchema)

/**
 * `bytes`, once checked to be the file `entry`'s attachment describes: its
 * `size`, and its `hash` (base64 SHA-256, as the importers write it).
 */
const checkedAttachmentBytes = (
  entry: Entry.Resource,
  attachmentPath: string,
  bytes: Uint8Array
): Effect.Effect<Uint8Array, UnreadableFile> =>
  Effect.gen(function* () {
    const attachment =
      entry.resource.resourceType === 'DocumentReference'
        ? entry.resource.content[0]?.attachment
        : undefined
    const size = attachment?.size ?? null
    const hash = attachment?.hash ?? null
    if (size !== bytes.length) {
      return yield* new UnreadableFile({
        path: attachmentPath,
        reason: `It is ${bytes.length} bytes; its DocumentReference says ${size ?? 'nothing'}.`,
      })
    }
    const digest = yield* sha256Base64(new Uint8Array(bytes)).pipe(
      Effect.mapError(
        (error) =>
          new UnreadableFile({
            path: attachmentPath,
            reason: `Its SHA-256 cannot be computed: ${error.reason}`,
          })
      )
    )
    if (digest !== hash) {
      return yield* new UnreadableFile({
        path: attachmentPath,
        reason: `Its SHA-256 is ${digest}; its DocumentReference says ${hash ?? 'nothing'}.`,
      })
    }
    return bytes
  })

/**
 * The resource a snapshot's resource file holds, as the import wrote it: a
 * source file's linked file is fetched, checked and carried inline again.
 *
 * @param source - Where the snapshot's files are fetched from
 * @param path - A resource's path, as the header lists it
 * @returns The resource; an {@link UnreadableFile} naming the file at fault
 *   for a path outside the resource path grammar (nothing is fetched), a file
 *   that cannot be fetched or decoded, that holds a resource other than the
 *   one its path names, a source file that does not link its file where the
 *   snapshot puts it, another resource that links a file, or a linked file that is not the one its attachment
 *   describes
 */
const readResource = (
  source: Source,
  path: string
): Effect.Effect<Entry.StoredResource, UnreadableFile> =>
  Effect.gen(function* () {
    yield* decodeResourcePath(path).pipe(Effect.mapError(unreadableAt(path)))
    const text = yield* source.text(path)
    const entry = yield* decodeResourceFile({ _tag: 'Text', path, text }).pipe(
      Effect.mapError(unreadableAt(path))
    )
    const { attachmentPath } = entry
    if (attachmentPath === undefined) return entry.resource
    const bytes = yield* checkedAttachmentBytes(
      entry,
      attachmentPath,
      yield* source.bytes(attachmentPath)
    )
    return Entry.withAttachmentData(entry, bytes)
  })

export { readHeader, readResource, UnreadableFile }
export type { Source }
