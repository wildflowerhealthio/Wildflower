/**
 * The batch decode every format binding exposes — files and settings in, one
 * `FormatDecode.Result` out, never failing — and the one constructor that
 * builds it.
 *
 * @remarks
 * {@link make} is where source-file handling lives: it resolves each pick to
 * the reference its resources are stamped with, mints and lists the archives a
 * local pick stores, and provides the format's `SourceFile.Format` internally,
 * so what a binding writes is a literal and what a consumer holds requires
 * nothing.
 *
 * What differs between formats is {@link Config.partition} — which files are
 * decoded together. Left out, every file is its own set; a format whose files
 * must be read together (DICOM's studies) states how they group and gets the
 * same minting, key-namespacing and failure folding around it.
 *
 * @packageDocumentation
 */

import type { ParseResult } from 'effect'
import { Array as Arr, Effect, Either, Option, Schema } from 'effect'

import * as DecodedFile from './decoded-file.ts'
import * as FormatDecode from './format-decode.ts'
import * as MetaSource from './meta-source.ts'
import type * as PickedFile from './picked-file.ts'
import * as SourceFile from './source-file.ts'

/**
 * The batch decode the shell runs: every file of one format, under that
 * format's settings, never failing and requiring nothing.
 */
type Type<in TSettings, TFormat extends string> = (
  files: readonly PickedFile.Type[],
  settings: TSettings
) => Effect.Effect<FormatDecode.Result<TFormat>, never>

/** One claimed file with its position in the batch. */
interface Member {
  readonly file: PickedFile.Type
  /** The file's position in the pick — what its review keys are namespaced by. */
  readonly index: number
}

/** A pick that never reached a set, and the failure that kept it out. */
interface UnreadableMember {
  readonly member: Member
  readonly error: ParseResult.ParseError
}

/** What a {@link Config.partition} yields: the sets decoded together, and the picks it could not place. */
interface Partition<TMember extends Member> {
  /**
   * One set per thing decoded together, each non-empty and ordered so that its
   * first member is the set's representative — the slot its review keys are
   * namespaced by and the archive its resources are stamped with.
   */
  readonly fileSets: readonly Arr.NonEmptyReadonlyArray<TMember>[]
  /** The picks that belong to no set, in pick order. */
  readonly unreadable: readonly UnreadableMember[]
}

/** What a set's archives link to, read off the set's own decode. */
type ArchiveLinks = Pick<SourceFile.Type, 'subject' | 'related'>

/** What every decode config states, whatever its partition. */
interface BaseConfig<TFormat extends string> {
  readonly format: TFormat
  /** The format's source-file constants — {@link make} provides them internally. */
  readonly sourceFileFormat: SourceFile.FormatValue
  /**
   * What this set's archives link to, read off its decode.
   *
   * @remarks
   * Called with the decode rather than the bytes, so a format names the
   * subject and the related resources off what it already extracted. Left
   * out, an archive links to nothing — which keeps an engineering artifact out
   * of `Patient/$everything`.
   */
  readonly archiveLinks?: ((decoded: DecodedFile.DecodedFile) => ArchiveLinks) | undefined
}

/** A format whose files decode one at a time, each its own set. */
interface PerFileConfig<TFormat extends string, TSettings> extends BaseConfig<TFormat> {
  readonly partition?: undefined
  readonly decodeFileSet: (
    members: Arr.NonEmptyReadonlyArray<Member & { readonly sourceFile: SourceFile.Reference }>,
    settings: TSettings
  ) => Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError>
}

/** A format that states which of its files are decoded together. */
interface GroupedConfig<
  TFormat extends string,
  TSettings,
  TMember extends Member,
> extends BaseConfig<TFormat> {
  readonly partition: (files: readonly Member[]) => Partition<TMember>
  readonly decodeFileSet: (
    members: Arr.NonEmptyReadonlyArray<TMember & { readonly sourceFile: SourceFile.Reference }>,
    settings: TSettings
  ) => Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError>
}

/** What {@link make} needs of a format. */
type Config<TFormat extends string, TSettings, TMember extends Member = Member> =
  | PerFileConfig<TFormat, TSettings>
  | GroupedConfig<TFormat, TSettings, TMember>

/** The section title one picked file's minted archive is reviewed under. */
const SOURCE_FILE_SECTION_TITLE = 'Source file'

/** The section title several archives read together are reviewed under. */
const SOURCE_FILES_SECTION_TITLE = 'Source files'

/** The review key of a minted source-file row, stable across a settings re-decode. */
const sourceFileKey = (member: Member): string =>
  `${FormatDecode.keyPrefix(member.index, member.file)}source-file/${member.file.fileName}`

/** An archive that links to nothing — what a format with no `archiveLinks` mints. */
const noLinks: ArchiveLinks = { subject: Option.none(), related: [] }

const mintSourceFile = Schema.decode(SourceFile.FromNamedBytes)
const encodeArchive = Schema.encode(SourceFile.FromDocumentReference)

/** One member resolved: the reference its resources name, and the archive to store. */
interface Resolved<TMember extends Member> {
  readonly member: TMember
  readonly reference: SourceFile.Reference
  /** The minted source file, for a `local` pick; `none` for a `server` pick, already stored. */
  readonly minted: Option.Option<SourceFile.Type>
}

/**
 * Resolve one pick to the source file its resources name: the stored one for a
 * `server` pick, a freshly minted one for a `local` pick.
 */
const resolve = <TMember extends Member>(
  member: TMember
): Effect.Effect<Resolved<TMember>, ParseResult.ParseError, SourceFile.Format> => {
  const { source } = member.file
  if (source._tag === 'server') {
    return Effect.succeed({ member, reference: source.reference, minted: Option.none() })
  }
  return Effect.map(mintSourceFile(member.file), (sourceFile) => ({
    member,
    reference: SourceFile.makeReference(sourceFile.id),
    minted: Option.some(sourceFile),
  }))
}

/**
 * Decode one set: resolve its picks, decode them together, namespace and stamp
 * what came out, and lead with the archives it minted.
 */
const decodeSet = <TSettings, TMember extends Member>(
  members: readonly TMember[],
  settings: TSettings,
  decodeFileSet: (
    members: Arr.NonEmptyReadonlyArray<TMember & { readonly sourceFile: SourceFile.Reference }>,
    settings: TSettings
  ) => Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError>,
  archiveLinks: (decoded: DecodedFile.DecodedFile) => ArchiveLinks
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError, SourceFile.Format> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.forEach(members, resolve, { concurrency: 'unbounded' })
    if (!Arr.isNonEmptyReadonlyArray(resolved)) return { sections: [], notes: [] }
    const head = resolved[0]

    const decoded = yield* decodeFileSet(
      Arr.map(resolved, (one) => ({ ...one.member, sourceFile: one.reference })),
      settings
    )
    const stamped = MetaSource.stampDecoded(
      DecodedFile.namespaceKeys(
        decoded,
        FormatDecode.keyPrefix(head.member.index, head.member.file)
      ),
      head.reference
    )

    const links = archiveLinks(decoded)
    const rows: DecodedFile.Resource[] = []
    for (const one of resolved) {
      if (Option.isNone(one.minted)) continue
      rows.push({
        key: sourceFileKey(one.member),
        title: one.member.file.fileName,
        resource: yield* encodeArchive({ ...one.minted.value, ...links }),
      })
    }
    if (rows.length === 0) return stamped

    // Their own section ahead of what was read out of them, so the reviewer
    // sees what is about to be stored before what it yielded.
    const title = rows.length === 1 ? SOURCE_FILE_SECTION_TITLE : SOURCE_FILES_SECTION_TITLE
    return { ...stamped, sections: [{ title, resources: rows }, ...stamped.sections] }
  })

/** The `unreadableFiles` row one pick is reported as. */
const unreadableRow = (
  format: string,
  member: Member,
  error: ParseResult.ParseError
): FormatDecode.UnreadableFile => ({
  id: FormatDecode.makeFileId(format, member.index, member.file),
  title: member.file.fileName,
  pickedFile: member.file,
  error,
})

/** Decode every set concurrently and fold them into the format's one result. */
const runSets = <TFormat extends string, TSettings, TMember extends Member>(
  files: readonly PickedFile.Type[],
  settings: TSettings,
  format: TFormat,
  partitioned: Partition<TMember>,
  decodeFileSet: (
    members: Arr.NonEmptyReadonlyArray<TMember & { readonly sourceFile: SourceFile.Reference }>,
    settings: TSettings
  ) => Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError>,
  archiveLinks: (decoded: DecodedFile.DecodedFile) => ArchiveLinks
): Effect.Effect<FormatDecode.Result<TFormat>, never, SourceFile.Format> =>
  Effect.forEach(
    partitioned.fileSets,
    (
      members
    ): Effect.Effect<
      Either.Either<DecodedFile.DecodedFile, readonly FormatDecode.UnreadableFile[]>,
      never,
      SourceFile.Format
    > =>
      decodeSet(members, settings, decodeFileSet, archiveLinks).pipe(
        Effect.map(Either.right),
        Effect.catchAll((error) =>
          // A set is read as a whole, so a set that rejects rejects every pick
          // in it — each with its own row, naming the file the reviewer picked.
          Effect.succeed(Either.left(members.map((member) => unreadableRow(format, member, error))))
        )
      ),
    { concurrency: 'unbounded' }
  ).pipe(
    Effect.map((results): FormatDecode.Result<TFormat> => {
      const sections: DecodedFile.Section[] = []
      const notes: string[] = []
      // The picks no set claimed come first, in pick order, ahead of the sets
      // that rejected.
      const unreadableFiles: FormatDecode.UnreadableFile[] = partitioned.unreadable.map((one) =>
        unreadableRow(format, one.member, one.error)
      )
      for (const result of results) {
        Either.match(result, {
          onLeft: (rejected) => unreadableFiles.push(...rejected),
          onRight: (decoded) => {
            sections.push(...decoded.sections)
            notes.push(...decoded.notes)
          },
        })
      }
      return {
        id: FormatDecode.makeId(format, files),
        title: files.map((file) => file.fileName).join(', '),
        files,
        format,
        decoded: { sections, notes },
        unreadableFiles,
      }
    })
  )

/** Every pick as its own set, in pick order — what a format that states no partition gets. */
const eachFileAlone = (files: readonly Member[]): Partition<Member> => ({
  fileSets: files.map((member) => Arr.of(member)),
  unreadable: [],
})

/**
 * Build a format's batch `decode` from how its files group and how one group
 * reads.
 *
 * @param config - The format's tag, its source-file constants, its
 *   `decodeFileSet`, and — for a format whose files are read together — its
 *   `partition` and `archiveLinks`
 * @returns The format's batch decode: never failing, requiring nothing
 *
 * @remarks
 * Sets are decoded concurrently and each is independent: one that rejects
 * yields an `unreadableFiles` row per pick in it while the rest stay
 * reviewable. Within a set the archives are minted concurrently too, but they
 * are encoded after the decode, because {@link BaseConfig.archiveLinks} reads
 * it.
 */
const make = <TFormat extends string, TSettings, TMember extends Member = Member>(
  config: Config<TFormat, TSettings, TMember>
): Type<TSettings, TFormat> => {
  const archiveLinks = config.archiveLinks ?? ((): ArchiveLinks => noLinks)
  return (files, settings): Effect.Effect<FormatDecode.Result<TFormat>, never> => {
    const members = files.map((file, index): Member => ({ file, index }))
    const decoded =
      config.partition === undefined
        ? runSets(
            files,
            settings,
            config.format,
            eachFileAlone(members),
            config.decodeFileSet,
            archiveLinks
          )
        : runSets(
            files,
            settings,
            config.format,
            config.partition(members),
            config.decodeFileSet,
            archiveLinks
          )
    return Effect.provideService(decoded, SourceFile.Format, config.sourceFileFormat)
  }
}

export { SOURCE_FILE_SECTION_TITLE, SOURCE_FILES_SECTION_TITLE, make }
export type {
  ArchiveLinks,
  Config,
  GroupedConfig,
  Member,
  Partition,
  PerFileConfig,
  Type,
  UnreadableMember,
}
