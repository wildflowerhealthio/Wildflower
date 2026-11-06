/**
 * "A file-format importer" as one first-class value.
 *
 * @packageDocumentation
 */
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Data, type Effect } from 'effect'

import type * as DecodeFunction from './decode-function.ts'
import type * as DecodedFile from './decoded-file.ts'
import type * as PickedFile from './picked-file.ts'

/** One picked file of a set, beside the source file the import stage stores it as. */
interface PickedSourceFile {
  readonly pickedFile: PickedFile.Type
  readonly sourceFile: PickedFile.SourceFile
}

/**
 * A record names a file by an identifier that no picked file of its set
 * identifies as, so `linkToSourceFiles` has no source file to point it at.
 *
 * @remarks
 * The import stage reports the set's picked files as unreadable rather than
 * store a record pointing at a file that is not there.
 */
class SourceFileNotFound extends Data.TaggedError('SourceFileNotFound')<{
  readonly identifier: IdentifierAndReference.IdentifierType
}> {
  // Data.TaggedError leaves `.message` empty by default; a human-readable
  // description keeps the failure legible to whoever surfaces it.
  override get message(): string {
    return `no picked file identifies as ${this.identifier.system?.href ?? '(no system)'} ${this.identifier.value ?? '(no value)'}`
  }
}

/**
 * Everything the shell needs to turn a picked file of one format into
 * reviewed, opt-in-written resources. Each format binding
 * (`har-importer-core`, etc.) writes one as a literal; the registry lists
 * them.
 *
 * @remarks
 * A plain record, not a class instance: an adapter layer extends an importer
 * by spreading it — which is how `importer-react`'s registry attaches a
 * format's `SettingsPicker` — and a spread is only total when there is no
 * prototype to lose.
 *
 * There is no constructor: every field is either a constant the binding states
 * or a function it already has. `decode` comes from `DecodeFunction.make`;
 * the source-file constants and the two hooks below are what `importer-core`'s
 * import stage reads when it builds and stores a set's source files.
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
   * Fills in what a source file points at, from the records read out of the
   * files it was decoded with.
   *
   * @remarks
   * The import stage calls it once for each picked file, after it has decoded
   * the file's set and built the file's source-file `DocumentReference`. It is
   * given that `DocumentReference` and every record the set decoded to, and
   * returns the `DocumentReference` to store. DICOM's sets `subject` to the
   * study's `Patient` and `context.related` to its `ImagingStudy`, so the
   * stored file sits in the patient's record beside the study it holds.
   *
   * **It must return the `id` it was given.** That id is a hash of the file's
   * bytes and name, which is what makes importing the same file again update
   * the one stored copy instead of adding a second; the review row and every
   * record's `meta.source` use whatever id comes back.
   *
   * Left out, the source file is stored as built, with no `subject` and no
   * `related`, which keeps a file that is not about a patient out of
   * `Patient/$everything`.
   */
  readonly linkSourceFile?:
    | ((
        sourceFile: PickedFile.SourceFile,
        decoded: DecodedFile.DecodedFile
      ) => PickedFile.SourceFile)
    | undefined
  /**
   * Points a record at the source files it was read from, for a format whose
   * records name their own file.
   *
   * @remarks
   * The import stage calls it once for each record of a set, after
   * `linkSourceFile` has run on every source file of the set. It is given the
   * record and, for each picked file of the set, the picked file and its
   * source-file `DocumentReference` ({@link PickedSourceFile}), and returns the
   * record to store. The decode never sees a source file's id, so the hook
   * finds a record's file by `masterIdentifier`: each `DocumentReference`
   * carries there what the decode said its picked file identifies as
   * (`DecodedFileSet.PickedFileIdentity`).
   *
   * DICOM's sets each `ImagingStudy` instance's `gridfsFileId` extension to the
   * id of the source file whose `masterIdentifier` is the instance's SOP
   * Instance UID, so the OHIF viewer can fetch that instance's image.
   *
   * A record naming a file that no source file of the set identifies as fails
   * with {@link SourceFileNotFound}; the import stage then reports every
   * picked file of that set as unreadable and the rest of the batch stays
   * reviewable.
   *
   * Left out, every record is stored as it is.
   */
  readonly linkToSourceFiles?:
    | ((
        resource: FhirResourceWithId,
        sourceFiles: readonly PickedSourceFile[]
      ) => Effect.Effect<FhirResourceWithId, SourceFileNotFound>)
    | undefined
}

export { SourceFileNotFound }
export type { PickedSourceFile, Type }
