import { DateTime, Effect, Either, Encoding, ParseResult, Schema } from 'effect'
import { joinIdComponents, localResourceId } from 'fhir-r4/identity'
import { DocumentReference, type FhirResource } from 'fhir-r4/resources'
import type * as FhirR4 from 'fhir/r4.d.ts'
import type * as DecodedFile from './decoded-file.ts'
import * as FormatDecode from './format-decode.ts'
import * as MetaSource from './meta-source.ts'
import type { PickedFile } from './picked-file.ts'
import { sha256Base64 } from './sha256.ts'
import * as SourceFileFhirReference from './source-file-fhir-reference.ts'

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

interface SourceFile {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: DateTime.Utc
  readonly bytes: Uint8Array
}

interface SourceFileEncoded {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: string
  readonly bytes: string
}

// ─── Decode Types ───────────────────────────────────────────────────────────

interface SourceFileRef {
  readonly id: string
}

type DecodeOne<TSettings> = (
  file: PickedFile,
  settings: TSettings,
  source: SourceFileRef
) => Effect.Effect<DecodedFile.DecodedFile<FhirResource>, ParseResult.ParseError>

// ─── Source File Review Helpers ─────────────────────────────────────────────

const sourceFileKey = (fileName: string): string => `source-file/${fileName}`

const SOURCE_FILE_SECTION_TITLE = 'Source file'

interface SourceFileResolved {
  readonly ref: SourceFileRef
  readonly labeled: DecodedFile.Resource<DocumentReferenceType> | undefined
}

const mintedWithoutId = (fileName: string): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Type(
      Schema.String.ast,
      fileName,
      `Source file minted without an id: ${fileName}`
    ),
  })

type BuildSourceFile = (
  picked: { readonly fileName: string; readonly bytes: Uint8Array },
  options?: { readonly subject?: { readonly reference: string } }
) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError>

const resolveSourceFile = (
  buildSourceFile: BuildSourceFile,
  file: PickedFile,
  options?: { readonly subject?: { readonly reference: string } | undefined }
): Effect.Effect<SourceFileResolved, ParseResult.ParseError> => {
  if (file.source._tag === 'server') {
    const { reference } = file.source
    return Effect.succeed({
      ref: { id: SourceFileFhirReference.idOf(reference) },
      labeled: undefined,
    })
  }
  return buildSourceFile(file, { subject: options?.subject }).pipe(
    Effect.flatMap((resource): Effect.Effect<SourceFileResolved, ParseResult.ParseError> => {
      const { id } = resource
      if (id === null) return Effect.fail(mintedWithoutId(file.fileName))
      return Effect.succeed({
        ref: { id },
        labeled: { key: sourceFileKey(file.fileName), title: file.fileName, resource },
      })
    })
  )
}

const withSourceSections = <TParsed>(
  decoded: DecodedFile.DecodedFile<TParsed>,
  sourceFiles: readonly DecodedFile.Resource<TParsed>[]
): DecodedFile.DecodedFile<TParsed> => {
  if (sourceFiles.length === 0) return decoded
  const sections: readonly DecodedFile.Section<TParsed>[] = sourceFiles.map((sourceFile) => ({
    title: SOURCE_FILE_SECTION_TITLE,
    resources: [sourceFile],
  }))
  return { ...decoded, sections: [...sections, ...decoded.sections] }
}

interface PerFileDecodeOptions {
  readonly subjectFor?: (file: PickedFile) => { readonly reference: string } | undefined
}

const buildPerFileDecode =
  <TFormat extends string, TSettings>(
    provider: {
      readonly format: TFormat
      readonly buildSourceFile: BuildSourceFile
    },
    decodeOne: DecodeOne<TSettings>,
    options?: PerFileDecodeOptions
  ) =>
  (
    files: readonly PickedFile[],
    settings: TSettings
  ): Effect.Effect<FormatDecode.Result<TFormat>> =>
    Effect.forEach(
      files,
      (file) =>
        Effect.gen(function* () {
          const { ref, labeled } = yield* resolveSourceFile(provider.buildSourceFile, file, {
            subject: options?.subjectFor?.(file),
          })
          const decoded = yield* decodeOne(file, settings, ref)
          const stamped = MetaSource.stampDecoded(decoded, SourceFileFhirReference.make(ref.id))
          return Either.right(withSourceSections(stamped, labeled === undefined ? [] : [labeled]))
        }).pipe(
          Effect.catchAll(
            (
              error
            ): Effect.Effect<
              Either.Either<DecodedFile.DecodedFile<FhirResource>, FormatDecode.UnreadableFile>
            > =>
              Effect.succeed(
                Either.left({
                  id: FormatDecode.makeId(provider.format, [file]),
                  title: file.fileName,
                  pickedFile: file,
                  error,
                })
              )
          )
        ),
      { concurrency: 'unbounded' }
    ).pipe(
      Effect.map((results): FormatDecode.Result<TFormat> => {
        const sections: DecodedFile.Section<FhirResource>[] = []
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

/**
 * "A file-format importer" as one first-class value: everything the shell
 * needs to turn a picked file of one format into reviewed, opt-in-written
 * resources. Each format binding (`har-importer-core`, etc.) instantiates
 * one; the registry lists them.
 *
 * The source-file FHIR encoding is built internally from the format's coding
 * and content type — every format stores its uploaded source file as a
 * `DocumentReference` with one attachment carrying the bytes verbatim, keyed
 * under a per-format `type`/`category` coding. The class builds the schemas,
 * the deterministic id mint, the read-back, and the batch decode from the
 * constructor config; a binding supplies its coding constants and a per-file
 * decode function, nothing else.
 */
class FileImporter<TFormat extends string, TSettings> {
  readonly format: TFormat
  readonly display: { readonly title: string; readonly description: string }
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
  readonly defaultSettings: TSettings
  readonly decode: (
    files: readonly PickedFile[],
    settings: TSettings
  ) => Effect.Effect<FormatDecode.Result<TFormat>>
  readonly categoryToken: string
  readonly contentType: string
  readonly isSourceFile: (resource: DocumentReferenceType) => boolean
  readonly sourceFileFromDocumentReference: (
    resource: DocumentReferenceType
  ) => Effect.Effect<SourceFile, ParseResult.ParseError>
  readonly sourceFileToDocumentReference: (
    sourceFile: SourceFile
  ) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError>
  readonly buildSourceFile: BuildSourceFile

  constructor(
    config:
      | {
          readonly format: TFormat
          readonly coding: Coding
          readonly contentType: string
          readonly display: { readonly title: string; readonly description: string }
          readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
          readonly defaultSettings: TSettings
          readonly decodeOne: DecodeOne<TSettings>
          readonly securityLabel?: readonly Coding[] | undefined
          readonly subjectFor?: (file: PickedFile) => { readonly reference: string } | undefined
        }
      | { readonly from: FileImporter<TFormat, TSettings> }
  ) {
    if ('from' in config) {
      const source = config.from
      this.format = source.format
      this.display = source.display
      this.detect = source.detect
      this.defaultSettings = source.defaultSettings
      this.decode = source.decode
      this.categoryToken = source.categoryToken
      this.contentType = source.contentType
      this.isSourceFile = source.isSourceFile
      this.sourceFileFromDocumentReference = source.sourceFileFromDocumentReference
      this.sourceFileToDocumentReference = source.sourceFileToDocumentReference
      this.buildSourceFile = source.buildSourceFile
      return
    }

    const { coding, contentType, securityLabel } = config
    const descriptionPrefix = `${config.display.title}: `
    const sourceFileName = `${pascalCase(config.format)}SourceFile`

    this.format = config.format
    this.display = config.display
    this.detect = config.detect
    this.defaultSettings = config.defaultSettings
    this.contentType = contentType
    this.categoryToken = `${coding.system}|${coding.code}`

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
      readonly sourceFile: SourceFile
      readonly hash: string
      readonly subject: { readonly reference: string } | undefined
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
      (concept?.coding ?? []).some(
        (one) => one.system === coding.system && one.code === coding.code
      )

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

    const SourceFileFromDocumentReference: Schema.Schema<SourceFile, DocumentReferenceType> =
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
          encode: (sourceFile, _options, ast) =>
            sha256Base64(new Uint8Array(sourceFile.bytes)).pipe(
              Effect.mapError((error) => new ParseResult.Type(ast, sourceFile, error.reason)),
              Effect.flatMap((hash) =>
                decodeResource(toWire({ sourceFile, hash, subject: undefined }))
              )
            ),
        }
      ).annotations({
        identifier: `${sourceFileName}FromDocumentReference`,
        description: `One uploaded ${config.display.title.toLowerCase()} source file, encoded as a FHIR R4 DocumentReference.`,
      })

    this.isSourceFile = (resource: DocumentReferenceType): boolean =>
      resource.category.some((category) =>
        category.coding.some(
          (one) => one.system?.toString() === coding.system && one.code === coding.code
        )
      )

    this.sourceFileFromDocumentReference = Schema.decode(SourceFileFromDocumentReference)
    this.sourceFileToDocumentReference = Schema.encode(SourceFileFromDocumentReference)

    this.buildSourceFile = (
      picked: {
        readonly fileName: string
        readonly bytes: Uint8Array
      },
      options?: { readonly subject?: { readonly reference: string } }
    ): Effect.Effect<DocumentReferenceType, ParseResult.ParseError> =>
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
        return yield* decodeResource(
          toWire({
            sourceFile: { id, fileName: picked.fileName, uploadedAt, bytes },
            hash,
            subject: options?.subject,
          })
        ).pipe(Effect.mapError(ParseResult.parseError))
      })

    this.decode = buildPerFileDecode(this, config.decodeOne, {
      subjectFor: config.subjectFor,
    })
  }
}

const identify = <D extends Pick<FileImporter<string, never>, 'detect'>>(
  descriptors: readonly D[],
  file: { readonly fileName: string; readonly bytes: Uint8Array }
): D | undefined => descriptors.find((descriptor) => descriptor.detect(file.bytes, file.fileName))

export { FileImporter, SOURCE_FILE_SECTION_TITLE, identify, sourceFileKey }
export type {
  Coding,
  DecodedFile,
  DecodeOne,
  DocumentReferenceType,
  PerFileDecodeOptions,
  SettingsPickerProps,
  SourceFile,
  SourceFileEncoded,
  SourceFileRef,
}
