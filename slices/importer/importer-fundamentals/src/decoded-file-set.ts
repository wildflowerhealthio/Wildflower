/**
 * One file set as its format decoded it: the picked files read together, and
 * the records read out of them, before the import stage makes them the
 * device's.
 *
 * @packageDocumentation
 */
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResource, FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import type { SystemFamily } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Array as Arr, Data, Option } from 'effect'

import type * as DecodedFile from './decoded-file.ts'
import type * as PickedFile from './picked-file.ts'

/**
 * A titled group of records from one source batch, as the import stage
 * receives it: every record already adopted, or each beside the key it is
 * adopted under. Every entry carries its review key and its title.
 *
 * @remarks
 * - `Adopted`: every record already the device's own, with its `wf-` id; the
 *   import stage keeps each as it is. What every format's `decodeFileSet`
 *   still returns, wrapped by `DecodeFunction.make` ({@link ofAdopted}).
 *   Transitional, while decoders still adopt what they read.
 * - `FromSource`: each record as its source gave it, beside its key less its
 *   type: the `system` its source id is unique in, an absolute URI, and the
 *   `sourceId` in it. A decoder that reads records with source ids builds one
 *   per source batch: LifeLabs' and DICOM's under a `FixedAcrossResourceTypes`
 *   family, each of a HAR's URL batches under its
 *   `RecognizedUrlData.systemFamily`. Each record's `system` and `sourceId`
 *   are what `fhir-r4-adoption`'s `DecodedId.of` reads: its own id under
 *   `SystemFamily.systemFor(family, type)`, else `CONTENT_DIGEST_SYSTEM` and a
 *   digest of its content. The import stage adopts each (`adoptUnderKey`), its
 *   references keyed in the section's `systemFamily`: one family per batch,
 *   not per record.
 *
 * The section listing a set's source files is built by the import stage,
 * never decoded.
 */
type Section = Data.TaggedEnum<{
  Adopted: {
    readonly title: string
    readonly entries: readonly {
      readonly key: string
      readonly title: string
      readonly resource: FhirResourceWithId
    }[]
  }
  FromSource: {
    readonly title: string
    readonly systemFamily: SystemFamily.Type
    readonly entries: readonly {
      readonly key: string
      readonly title: string
      readonly system: string
      readonly sourceId: string
      readonly resource: FhirResource
    }[]
  }
}>

const Section = Data.taggedEnum<Section>()

/**
 * One picked file of a set, beside what its own content identifies it as.
 *
 * @remarks
 * `identifiedAs` is a FHIR `Identifier` the decode read out of the file, for a
 * format whose files name themselves (a DICOM file's SOP Instance UID), and
 * `None` for one whose files do not. The import stage writes it onto the
 * file's source file as `DocumentReference.masterIdentifier`, which is how a
 * record names the source file it was read from without the decode knowing
 * that source file (`FileImporter`'s `linkToSourceFiles`).
 */
interface PickedFileIdentity {
  readonly pickedFile: PickedFile.Type
  readonly identifiedAs: Option.Option<IdentifierAndReference.IdentifierType>
}

/**
 * One file set's decode: its picked files, in the order they were picked, each
 * with what it identifies itself as, and its sections and notes, every review
 * key already namespaced by the set's first picked file
 * (`FormatDecode.keyPrefix`).
 */
interface Type {
  readonly pickedFiles: Arr.NonEmptyReadonlyArray<PickedFileIdentity>
  readonly sections: readonly Section[]
  readonly notes: readonly string[]
}

/**
 * `decoded`, a set's decode of already adopted resources, as `Adopted`
 * sections.
 *
 * @param identifiedAs - What each picked file identifies itself as, by the
 *   picked file's `id`; a file it leaves out, or every file when it is left
 *   out, identifies as nothing
 */
const ofAdopted = (
  pickedFiles: Arr.NonEmptyReadonlyArray<PickedFile.Type>,
  decoded: DecodedFile.DecodedFile,
  identifiedAs: ReadonlyMap<string, IdentifierAndReference.IdentifierType> = new Map()
): Type => ({
  pickedFiles: Arr.map(pickedFiles, (pickedFile) => ({
    pickedFile,
    identifiedAs: Option.fromNullable(identifiedAs.get(pickedFile.id)),
  })),
  sections: decoded.sections.map((section) =>
    Section.Adopted({ title: section.title, entries: section.resources })
  ),
  notes: decoded.notes,
})

export { ofAdopted, Section }
export type { PickedFileIdentity, Type }
