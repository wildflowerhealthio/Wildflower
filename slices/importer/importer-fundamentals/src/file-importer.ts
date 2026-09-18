import { DateTime, Effect, Either, Encoding, ParseResult, Schema, type SchemaAST } from 'effect'
import { joinIdComponents, localResourceId } from 'fhir-r4/identity'
import { DocumentReference } from 'fhir-r4/resources'
import type * as FhirR4 from 'fhir/r4.d.ts'
import * as DecodedFile from './decoded-file.ts'
import * as FormatDecode from './format-decode.ts'
import * as MetaSource from './meta-source.ts'
import type { NamedBytes, PickedFile } from './picked-file.ts'
import { sha256Base64 } from './sha256.ts'
import * as SourceFile from './source-file.ts'

// ─── Shared Types ───────────────────────────────────────────────────────────

type DocumentReferenceType = typeof DocumentReference.Schema.Type

interface SettingsPickerProps<TSettings> {
  readonly settings: TSettings
  readonly onChange: (settings: TSettings) => void
}

// ─── Source File Types ──────────────────────────────────────────────────────

interface Coding {
  readonly system: string
  readonly code: string
}

/** The two source-file operations `buildPerFileDecode` drives, as a `FileImporter` supplies them. */
interface SourceFileMint {
  readonly mintSourceFile: (
    picked: NamedBytes
  ) => Effect.Effect<SourceFile.Type, ParseResult.ParseError>
  readonly sourceFileToDocumentReference: (
    sourceFile: SourceFile.Type,
    subject?: SourceFile.Subject
  ) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError>
}

// ─── Per-File Decode ────────────────────────────────────────────────────────

/**
 * What one file resolved to before its decode ran.
 *
 * @remarks
 * A `local` pick's source file is minted here but built *after* the decode, so
 * it can be filed under the subject `subjectFor` reads off the decode's own
 * resources. `mintResource` is that deferred build — `undefined` for a `server`
 * pick, whose resource is already stored.
 */
interface ResolvedSource {
  readonly reference: SourceFile.Reference
  readonly mintResource:
    | ((
        subject: SourceFile.Subject | undefined
      ) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError>)
    | undefined
}

const resolveSource = (
  mint: SourceFileMint,
  file: PickedFile
): Effect.Effect<ResolvedSource, ParseResult.ParseError> => {
  if (file.source._tag === 'server') {
    return Effect.succeed({ reference: file.source.reference, mintResource: undefined })
  }
  return mint.mintSourceFile(file).pipe(
    Effect.map((sourceFile) => ({
      reference: SourceFile.makeReference(sourceFile.id),
      mintResource: (subject: SourceFile.Subject | undefined) =>
        mint.sourceFileToDocumentReference(sourceFile, subject),
    }))
  )
}

/**
 * Lift one format's per-file `decodeOne` into the batch `decode` the shell
 * runs: one file at a time, each contributing its own "Source file" row, its
 * sections under its own key namespace, and its own unreadable row when it
 * rejects.
 *
 * @param provider - The format tag and the source-file mint the rows come from
 * @param decodeOne - The format's per-file decode
 * @param options - `subjectFor`, when the format files its source file under a subject
 * @returns The format's batch `decode`, which never fails
 */
const buildPerFileDecode =
  <TFormat extends string, TSettings>(
    provider: SourceFileMint & { readonly format: TFormat },
    decodeOne: SourceFile.DecodeOne<TSettings>,
    options?: SourceFile.PerFileDecodeOptions
  ) =>
  (
    files: readonly PickedFile[],
    settings: TSettings
  ): Effect.Effect<FormatDecode.Result<TFormat>> =>
    Effect.forEach(
      files,
      (file, index) => {
        const prefix = FormatDecode.keyPrefix(index, file)
        return Effect.gen(function* () {
          const { reference, mintResource } = yield* resolveSource(provider, file)
          const decoded = yield* decodeOne(file, settings, reference)
          const stamped = MetaSource.stampDecoded(
            DecodedFile.namespaceKeys(decoded, prefix),
            reference
          )
          if (mintResource === undefined) return Either.right(stamped)
          const resource = yield* mintResource(options?.subjectFor?.(file, decoded))
          return Either.right(
            SourceFile.prependToDecodedFile(stamped, {
              key: `${prefix}${SourceFile.key(file.fileName)}`,
              title: file.fileName,
              resource,
            })
          )
        }).pipe(
          Effect.catchAll(
            (
              error
            ): Effect.Effect<Either.Either<DecodedFile.DecodedFile, FormatDecode.UnreadableFile>> =>
              Effect.succeed(
                Either.left({
                  id: FormatDecode.makeFileId(provider.format, index, file),
                  title: file.fileName,
                  pickedFile: file,
                  error,
                })
              )
          )
        )
      },
      { concurrency: 'unbounded' }
    ).pipe(
      Effect.map((results): FormatDecode.Result<TFormat> => {
        const sections: DecodedFile.Section[] = []
        const notes: string[] = []
        const unreadableFiles: FormatDecode.UnreadableFile[] = []
        for (const result of results) {
          Either.match(result, {
            onLeft: (failure) => unreadableFiles.push(failure),
            onRight: (decoded) => {
              sections.push(...decoded.sections)
              notes.push(...decoded.notes)
            },
          })
        }
        return {
          id: FormatDecode.makeId(provider.format, files),
          title: files.map((f) => f.fileName).join(', '),
          files,
          format: provider.format,
          decoded: { sections, notes },
          unreadableFiles,
        }
      })
    )

// ─── Schema Annotation Derivation ──────────────────────────────────────────

const pascalCase = (format: string): string =>
  format
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('')

// ─── FileImporter ───────────────────────────────────────────────────────────

/** The constructor config a format binding supplies. */
interface FileImporterConfig<TFormat extends string, TSettings> {
  readonly format: TFormat
  readonly coding: Coding
  readonly contentType: string
  readonly display: { readonly title: string; readonly description: string }
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
  readonly defaultSettings: TSettings
  readonly decodeOne: SourceFile.DecodeOne<TSettings>
  readonly securityLabel?: readonly Coding[] | undefined
  readonly subjectFor?: SourceFile.SubjectFor
}

/**
 * "A file-format importer" as one first-class value: everything the shell
 * needs to turn a picked file of one format into reviewed, opt-in-written
 * resources. Each format binding (`har-importer-core`, etc.) builds one with
 * {@link fileImporter}; the registry lists them.
 *
 * @remarks
 * A plain record of closures, not a class instance: an adapter layer extends an
 * importer by spreading it — which is how `importer-react`'s registry attaches
 * each format's `SettingsPicker` — and a spread is only total when there is no
 * prototype to lose.
 */
interface FileImporter<TFormat extends string, TSettings> {
  readonly format: TFormat
  readonly display: { readonly title: string; readonly description: string }
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
  readonly defaultSettings: TSettings
  /** The batch decode the shell runs: one file at a time, never failing. */
  readonly decode: (
    files: readonly PickedFile[],
    settings: TSettings
  ) => Effect.Effect<FormatDecode.Result<TFormat>>
  /** The `system|code` search token the shell unions across formats. */
  readonly categoryToken: string
  /** The stored attachment's content type — what picks a preview's renderer. */
  readonly contentType: string
  /** Whether a `DocumentReference` off the server is one of this format's source files. */
  readonly isSourceFile: (resource: DocumentReferenceType) => boolean
  readonly sourceFileFromDocumentReference: (
    resource: DocumentReferenceType
  ) => Effect.Effect<SourceFile.Type, ParseResult.ParseError>
  /** Encode a source file as its `DocumentReference`, optionally filed under a subject. */
  readonly sourceFileToDocumentReference: (
    sourceFile: SourceFile.Type,
    subject?: SourceFile.Subject
  ) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError>
  /** Decide a picked file's deterministic source file — its id, name, and upload instant. */
  readonly mintSourceFile: (
    picked: NamedBytes
  ) => Effect.Effect<SourceFile.Type, ParseResult.ParseError>
  /** Mint a picked file and encode it in one step — {@link mintSourceFile} then {@link sourceFileToDocumentReference}. */
  readonly buildSourceFile: (
    picked: NamedBytes,
    options?: { readonly subject?: SourceFile.Subject }
  ) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError>
}

/**
 * Build a format's {@link FileImporter} from its coding constants and its
 * per-file decode.
 *
 * @remarks
 * The source-file FHIR encoding is derived here rather than written per
 * binding — every format stores its uploaded source file as a
 * `DocumentReference` with one attachment carrying the bytes verbatim, keyed
 * under a per-format `type`/`category` coding. This builds the schemas, the
 * deterministic id mint, the read-back, and the batch decode from the config;
 * a binding supplies its coding constants and a per-file decode function,
 * nothing else.
 *
 * @param config - The format's tags, display strings, `detect`, settings and `decodeOne`
 * @returns The format's importer, ready for the registry
 */
const fileImporter = <TFormat extends string, TSettings>(
  config: FileImporterConfig<TFormat, TSettings>
): FileImporter<TFormat, TSettings> => {
  const { coding, contentType, securityLabel } = config
  const descriptionPrefix = `${config.display.title}: `
  const sourceFileName = `${pascalCase(config.format)}SourceFile`

  const SourceFileId = Schema.NonEmptyString.pipe(
    Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/u)
  ).annotations({
    identifier: `${sourceFileName}Id`,
    description: `FHIR resource id of an uploaded ${config.display.title.toLowerCase()} source file; deterministic in the file hash and name.`,
  })

  const SourceFileSchema = Schema.Struct({
    id: SourceFileId,
    fileName: Schema.NonEmptyString,
    uploadedAt: Schema.DateTimeUtc,
    bytes: Schema.Uint8ArrayFromBase64,
  })

  const decodeResource = ParseResult.decodeUnknown(DocumentReference.Schema)
  const encodeResource = ParseResult.encode(DocumentReference.Schema)
  const decodeSourceFile = ParseResult.decodeUnknown(SourceFileSchema)

  const toWire = ({
    sourceFile,
    hash,
    subject,
  }: {
    readonly sourceFile: SourceFile.Type
    readonly hash: string
    readonly subject: SourceFile.Subject | undefined
  }): FhirR4.DocumentReference => {
    const uploadedAt = DateTime.formatIso(sourceFile.uploadedAt)
    return {
      resourceType: 'DocumentReference',
      id: sourceFile.id,
      status: 'current',
      type: { coding: [{ system: coding.system, code: coding.code }] },
      category: [{ coding: [{ system: coding.system, code: coding.code }] }],
      date: uploadedAt,
      description: `${descriptionPrefix}${sourceFile.fileName}`,
      ...(subject === undefined ? {} : { subject }),
      ...(securityLabel === undefined
        ? {}
        : { securityLabel: [{ coding: securityLabel.map((one) => ({ ...one })) }] }),
      content: [
        {
          attachment: {
            contentType,
            data: Encoding.encodeBase64(sourceFile.bytes),
            size: sourceFile.bytes.length,
            hash,
            title: sourceFile.fileName,
            creation: uploadedAt,
          },
        },
      ],
    }
  }

  const hasSourceFileCoding = (concept: FhirR4.CodeableConcept | undefined): boolean =>
    (concept?.coding ?? []).some((one) => one.system === coding.system && one.code === coding.code)

  const readEncodedSourceFile = (
    wire: FhirR4.DocumentReference
  ): Either.Either<unknown, string> => {
    if (!hasSourceFileCoding(wire.type) || !(wire.category ?? []).some(hasSourceFileCoding)) {
      return Either.left(`Not a ${coding.code} document`)
    }
    const attachment = wire.content?.[0]?.attachment
    if (attachment === undefined) return Either.left('No content entry')
    if (attachment.data === undefined) return Either.left('Attachment carries no data')
    return Either.right({
      id: wire.id,
      fileName: attachment.title,
      uploadedAt: attachment.creation ?? wire.date,
      bytes: attachment.data,
    })
  }

  /**
   * Hash the bytes and build the source file's `DocumentReference`.
   *
   * @remarks
   * Takes the `ast` to blame so both callers — the codec's own `encode`, and the
   * subject-bearing `sourceFileToDocumentReference` below — report a digest
   * failure against the schema the caller was working in.
   */
  const encodeSourceFile = (
    sourceFile: SourceFile.Type,
    subject: SourceFile.Subject | undefined,
    ast: SchemaAST.AST
  ): Effect.Effect<DocumentReferenceType, ParseResult.ParseIssue> =>
    sha256Base64(new Uint8Array(sourceFile.bytes)).pipe(
      Effect.mapError((error) => new ParseResult.Type(ast, sourceFile, error.reason)),
      Effect.flatMap((hash) => decodeResource(toWire({ sourceFile, hash, subject })))
    )

  const SourceFileFromDocumentReference: Schema.Schema<SourceFile.Type, DocumentReferenceType> =
    Schema.transformOrFail(
      Schema.typeSchema(DocumentReference.Schema),
      Schema.typeSchema(SourceFileSchema),
      {
        strict: true,
        decode: (resource, _options, ast) =>
          encodeResource(resource).pipe(
            Effect.flatMap((wire) =>
              Either.match(readEncodedSourceFile(wire), {
                onLeft: (reason) =>
                  Effect.fail(
                    new ParseResult.Type(ast, resource, `${wire.id ?? '<no id>'}: ${reason}`)
                  ),
                onRight: (value) => decodeSourceFile(value),
              })
            )
          ),
        encode: (sourceFile, _options, ast) => encodeSourceFile(sourceFile, undefined, ast),
      }
    ).annotations({
      identifier: `${sourceFileName}FromDocumentReference`,
      description: `One uploaded ${config.display.title.toLowerCase()} source file, encoded as a FHIR R4 DocumentReference.`,
    })

  const mintSourceFile = (
    picked: NamedBytes
  ): Effect.Effect<SourceFile.Type, ParseResult.ParseError> =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(picked.bytes)
      const hash = yield* sha256Base64(bytes).pipe(
        Effect.mapError((error) =>
          ParseResult.parseError(new ParseResult.Type(SourceFileSchema.ast, picked, error.reason))
        )
      )
      const uploadedAt = yield* DateTime.now
      const id = localResourceId(
        coding.system,
        'DocumentReference',
        joinIdComponents([hash, picked.fileName])
      )
      return { id, fileName: picked.fileName, uploadedAt, bytes }
    })

  const validateSourceFile = ParseResult.validate(Schema.typeSchema(SourceFileSchema))

  const sourceFileToDocumentReference = (
    sourceFile: SourceFile.Type,
    subject?: SourceFile.Subject
  ): Effect.Effect<DocumentReferenceType, ParseResult.ParseError> =>
    validateSourceFile(sourceFile).pipe(
      Effect.flatMap((valid) =>
        encodeSourceFile(valid, subject, SourceFileFromDocumentReference.ast)
      ),
      Effect.mapError(ParseResult.parseError)
    )

  return {
    format: config.format,
    display: config.display,
    detect: config.detect,
    defaultSettings: config.defaultSettings,
    contentType,
    categoryToken: `${coding.system}|${coding.code}`,
    isSourceFile: (resource) =>
      resource.category.some((category) =>
        category.coding.some(
          (one) => one.system?.toString() === coding.system && one.code === coding.code
        )
      ),
    sourceFileFromDocumentReference: Schema.decode(SourceFileFromDocumentReference),
    sourceFileToDocumentReference,
    mintSourceFile,
    buildSourceFile: (picked, options) =>
      mintSourceFile(picked).pipe(
        Effect.flatMap((sourceFile) => sourceFileToDocumentReference(sourceFile, options?.subject))
      ),
    decode: buildPerFileDecode(
      { format: config.format, mintSourceFile, sourceFileToDocumentReference },
      config.decodeOne,
      { subjectFor: config.subjectFor }
    ),
  }
}

/** The one thing {@link identify} needs of a candidate: a syntactic `detect`. */
interface Detectable {
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
}

/** The first candidate whose `detect` claims the file, in the order given. */
const identify = <D extends Detectable>(
  candidates: readonly D[],
  file: NamedBytes
): D | undefined => candidates.find((candidate) => candidate.detect(file.bytes, file.fileName))

export { fileImporter, identify }
export type {
  Coding,
  Detectable,
  FileImporter,
  DocumentReferenceType,
  FileImporterConfig,
  SettingsPickerProps,
}
