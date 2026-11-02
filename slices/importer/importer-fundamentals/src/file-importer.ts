/**
 * "A file-format importer" as one first-class value.
 *
 * @packageDocumentation
 */
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'

import type * as DecodeFunction from './decode-function.ts'
import type * as DecodedFile from './decoded-file.ts'
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
 * or a function it already has. `decode` comes from `DecodeFunction.make`;
 * the source-file constants and the two hooks below are what `importer-core`'s
 * import stage reads when it mints a set's source files.
 *
 * `R` is what `decode` requires of whoever runs it: `never` for a format that
 * reads its bytes itself, a platform service (LifeLabs' PDF extraction) for
 * one that cannot. The registry's union of them is what `importer-core`'s
 * `readBatch` requires, and the host provides it.
 */
interface Type<TSettings, TFormat extends string, R = never> {
  readonly format: TFormat
  readonly display: { readonly title: string; readonly description: string }
  /** Claims a picked file — `format` and this together satisfy `FormatDetector.Type`. */
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
  readonly defaultSettings: TSettings
  /** The batch decode the shell runs: never failing, requiring `R` of its caller. */
  readonly decode: DecodeFunction.Type<TSettings, TFormat, R>
  /**
   * The format's source file constants — what its source files are written under,
   * and what a reader of the server's list searches, recognizes and decodes
   * with (`PickedFile.categoryToken`, `PickedFile.isSourceFile`,
   * `PickedFile.FromDocumentReference`).
   */
  readonly sourceFileFormat: PickedFile.FormatValue
  /**
   * What one set's source files are listed and stamped as, read off the set's
   * import.
   *
   * @remarks
   * Runs once per picked file of the set, with that picked file's source file,
   * as minted, and the set's records, adopted, so a format names the subject
   * and the related resources off what it already extracted. **The source
   * file's `id` must not change**: the row that is listed and the reference
   * every resource's `meta.source` names are both read off the result. Left
   * out, a source file is stored exactly as minted, which keeps an engineering
   * artifact out of `Patient/$everything`.
   */
  readonly linkSourceFile?:
    | ((
        sourceFile: PickedFile.SourceFile,
        decoded: DecodedFile.DecodedFile
      ) => PickedFile.SourceFile)
    | undefined
  /**
   * One adopted record of a set, finished once its source files are minted.
   *
   * @remarks
   * `sourceFileIds` holds each member's source file id by the member's pick
   * `id`, for a record that names the file it was read from. Left out, every
   * record is kept as it is.
   */
  readonly finish?:
    | ((
        resource: FhirResourceWithId,
        sourceFileIds: ReadonlyMap<string, string>
      ) => FhirResourceWithId)
    | undefined
}

export type { Type }
