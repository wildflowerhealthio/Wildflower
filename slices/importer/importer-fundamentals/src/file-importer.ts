/**
 * "A file-format importer" as one first-class value.
 *
 * @packageDocumentation
 */
import type * as DecodeFunction from './decode-function.ts'
import type * as PickedFile from './picked-file.ts'

/**
 * Everything the shell needs to turn a picked file of one format into
 * reviewed, opt-in-written resources. Each format binding
 * (`har-importer-core`, etc.) writes one as a literal; the registry lists
 * them.
 *
 * @remarks
 * A plain record, not a class instance: an adapter layer extends an importer
 * by spreading it — which is how `importer-react`'s registry attaches each
 * format's `SettingsPicker` — and a spread is only total when there is no
 * prototype to lose.
 *
 * There is no constructor: every field is either a constant the binding states
 * or a function it already has. `decode` comes from `DecodeFunction.make`,
 * which is where the source-file constants below are put to work.
 */
interface Type<TSettings, TFormat extends string> {
  readonly format: TFormat
  readonly display: { readonly title: string; readonly description: string }
  /** Claims a picked file — `format` and this together satisfy `FormatDetector.Type`. */
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
  readonly defaultSettings: TSettings
  /** The batch decode the shell runs: never failing, requiring nothing. */
  readonly decode: DecodeFunction.Type<TSettings, TFormat>
  /**
   * The format's archive constants — what its archives are written under,
   * and what a reader of the server's list searches, recognizes and decodes
   * with (`PickedFile.categoryToken`, `PickedFile.isSourceFile`,
   * `PickedFile.FromDocumentReference`).
   */
  readonly sourceFileFormat: PickedFile.FormatValue
}

export type { Type }
