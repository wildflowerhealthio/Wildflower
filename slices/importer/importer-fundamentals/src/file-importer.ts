import { Effect, type ParseResult, Schema, Function as Func } from 'effect'
import type * as DecodeFunction from './decode-function.ts'
import * as SourceFile from './source-file.ts'

/**
 * The constructor config a format binding supplies.
 *
 * @remarks
 * A binding writes each seam in the shape the thing that consumes it reads,
 * rather than as loose fields the factory would assemble: the source-file
 * constants as one `SourceFile.Format` (the value the codec is parameterized
 * by), and the batch decode as a still-unbound `DecodeFunction.WithContext` —
 * from `DecodeFunction.fromPerFile` for a format whose files decode one at a
 * time, or from whatever constructor suits one whose files do not.
 * `sourceFileFormat` is spelled once, here: the decode arrives
 * needing a `SourceFile.FormatContext` and {@link make} provides it, so the
 * constants the importer reads `categoryToken` and `isSourceFile` out of are
 * by construction the ones its decode mints under.
 * `descriptionPrefix` is the binding's too — conventionally
 * `${display.title}: `, spelled at the call site so a format that wants a
 * different prefix simply writes one.
 */
interface FileImporterConfig<TFormat extends string, TSettings> {
  readonly format: TFormat
  readonly sourceFileFormat: SourceFile.Format
  /** The format's batch decode, still needing the source-file context {@link make} binds. */
  readonly decode: DecodeFunction.WithContext<TSettings, TFormat, SourceFile.FormatContext>
  readonly display: { readonly title: string; readonly description: string }
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
  readonly defaultSettings: TSettings
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
interface Type<TSettings, TFormat extends string> {
  readonly format: TFormat
  readonly display: { readonly title: string; readonly description: string }
  /** Claims a picked file — `format` and this together satisfy `FormatDetector.Type`. */
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
  readonly defaultSettings: TSettings
  /** The batch decode the shell runs: one file at a time, never failing. */
  readonly decode: DecodeFunction.Type<TSettings, TFormat>
  /** The `system|code` search token the shell unions across formats. */
  readonly categoryToken: string
  /** The stored attachment's content type — what picks a preview's renderer. */
  readonly contentType: string
  /** Whether a `DocumentReference` off the server is one of this format's source files. */
  readonly isSourceFile: (resource: SourceFile.DocumentReferenceType) => boolean
  /**
   * The format's source-file constants, as the codec's `FormatContext` takes
   * them — the one piece of that binding this importer carries as data rather
   * than as a closure over it.
   */
  readonly sourceFileFormat: SourceFile.Format
  readonly sourceFileFromDocumentReference: (
    resource: SourceFile.DocumentReferenceType
  ) => Effect.Effect<SourceFile.Type, ParseResult.ParseError>
}

/**
 * Build a format's {@link Type} from its coding constants and its
 * per-file decode.
 *
 * @remarks
 * The source-file FHIR encoding is derived here rather than written per
 * binding — every format stores its uploaded source file as a
 * `DocumentReference` with one attachment carrying the bytes verbatim, keyed
 * under a per-format `type`/`category` coding. The codec itself lives in
 * `source-file.ts`, parameterized by a `SourceFile.FormatContext`; this is the
 * only place the config's `sourceFileFormat` is provided as that context — so
 * the schemas, the read-back and the batch decode all come out of the
 * factory requiring nothing, and all of them read one copy of the constants.
 * A binding supplies those constants and a per-file decode function, nothing
 * else.
 *
 * @param config - The format's source-file constants, decode config, display strings, `detect` and settings
 * @returns The format's importer, ready for the registry
 */
const make = <TFormat extends string, TSettings>(
  config: FileImporterConfig<TFormat, TSettings>
): Type<TSettings, TFormat> => {
  const { sourceFileFormat } = config
  const { contentType } = sourceFileFormat

  const provideSourceFileFormat = Effect.provideService(SourceFile.FormatContext, sourceFileFormat)

  return {
    format: config.format,
    display: config.display,
    detect: config.detect,
    defaultSettings: config.defaultSettings,
    contentType,
    sourceFileFormat,
    categoryToken: Func.pipe(SourceFile.categoryToken, provideSourceFileFormat, Effect.runSync),
    isSourceFile: Func.compose(
      Func.compose(SourceFile.inFormatsCategory, provideSourceFileFormat),
      Effect.runSync
    ),
    sourceFileFromDocumentReference: Func.compose(
      Schema.decode(SourceFile.FromDocumentReferenceSchema),
      provideSourceFileFormat
    ),
    decode: (files, settings) => provideSourceFileFormat(config.decode(files, settings)),
  }
}

export { make }
export type { Type, FileImporterConfig }
