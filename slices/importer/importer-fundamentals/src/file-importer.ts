import { Effect, type ParseResult, Schema, Function as Func } from 'effect'
import { type DocumentReference } from 'fhir-r4/resources'
import * as DecodeFunction from './decode-function.ts'
import type * as PickedFile from './picked-file.ts'
import * as SourceFile from './source-file.ts'

type DocumentReferenceType = typeof DocumentReference.Schema.Type

// ─── Shared Types ───────────────────────────────────────────────────────────

interface SettingsPickerProps<TSettings> {
  readonly settings: TSettings
  readonly onChange: (settings: TSettings) => void
}

// ─── FileImporter ───────────────────────────────────────────────────────────

/** The constructor config a format binding supplies. */
interface FileImporterConfig<TFormat extends string, TSettings> {
  readonly format: TFormat
  readonly coding: SourceFile.Coding
  readonly contentType: string
  readonly display: { readonly title: string; readonly description: string }
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
  readonly defaultSettings: TSettings
  readonly decodeOne: SourceFile.DecodeOne<TSettings>
  readonly securityLabel?: readonly SourceFile.Coding[] | undefined
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
 *
 * Every member requires nothing: the source-file codec's
 * `SourceFile.FormatContext` is bound by {@link fileImporter}, so no consumer
 * carries it.
 */
interface FileImporter<TSettings, TFormat extends string> {
  readonly format: TFormat
  readonly display: { readonly title: string; readonly description: string }
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
  readonly defaultSettings: TSettings
  /** The batch decode the shell runs: one file at a time, never failing. */
  readonly decode: DecodeFunction.Type<TSettings, TFormat>
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
    picked: PickedFile.NamedBytes
  ) => Effect.Effect<SourceFile.Type, ParseResult.ParseError>
  /** Mint a picked file and encode it in one step — {@link mintSourceFile} then {@link sourceFileToDocumentReference}. */
  readonly buildSourceFile: (
    picked: PickedFile.NamedBytes,
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
 * under a per-format `type`/`category` coding. The codec itself lives in
 * `source-file.ts`, parameterized by a `SourceFile.FormatContext`; this is
 * where that context is bound, once, from the config — so the schemas, the
 * deterministic mint, the read-back and the batch decode all come out of the
 * factory requiring nothing. A binding supplies its coding constants and a
 * per-file decode function, nothing else.
 *
 * @param config - The format's tags, display strings, `detect`, settings and `decodeOne`
 * @returns The format's importer, ready for the registry
 */
const fileImporter = <TFormat extends string, TSettings>(
  config: FileImporterConfig<TFormat, TSettings>
): FileImporter<TSettings, TFormat> => {
  const { coding, contentType, securityLabel } = config
  const descriptionPrefix = `${config.display.title}: `

  const provideSourceFileFormat = Effect.provideService(SourceFile.FormatContext, {
    coding,
    contentType,
    securityLabel,
    descriptionPrefix,
  })

  const batchDecode = DecodeFunction.fromProvider(
    {
      format: config.format,
      mintSourceFile: SourceFile.tryFromNamedBytes,
      sourceFileToDocumentReference: SourceFile.encodeSourceFile,
    },
    config.decodeOne,
    { subjectFor: config.subjectFor }
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
    sourceFileFromDocumentReference: Func.compose(
      Schema.decode(SourceFile.FromDocumentReferenceSchema),
      provideSourceFileFormat
    ),
    // Spelled out rather than `Func.compose`d: `compose` is unary, so composing
    // would silently drop `subject` at every call site.
    sourceFileToDocumentReference: (sourceFile, subject) =>
      provideSourceFileFormat(SourceFile.encodeSourceFile(sourceFile, subject)),
    mintSourceFile: Func.compose(SourceFile.tryFromNamedBytes, provideSourceFileFormat),
    buildSourceFile: (picked, options) =>
      Func.pipe(
        SourceFile.tryFromNamedBytes(picked),
        Effect.flatMap((sourceFile) => SourceFile.encodeSourceFile(sourceFile, options?.subject)),
        provideSourceFileFormat
      ),
    decode: (files, settings) => batchDecode(files, settings).pipe(provideSourceFileFormat),
  }
}

/** The one thing {@link identify} needs of a candidate: a syntactic `detect`. */
interface Detectable {
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
}

/** The first candidate whose `detect` claims the file, in the order given. */
const identify = <D extends Detectable>(
  candidates: readonly D[],
  file: PickedFile.NamedBytes
): D | undefined => candidates.find((candidate) => candidate.detect(file.bytes, file.fileName))

export { fileImporter, identify }
export type {
  Detectable,
  FileImporter,
  DocumentReferenceType,
  FileImporterConfig,
  SettingsPickerProps,
}
