/**
 * One file set as its format decoded it: the picked files read together, and
 * the records read out of them, before the import stage makes them the
 * device's.
 *
 * @packageDocumentation
 */
import type { FhirResource, FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import type { SystemFamily } from '@wildflowerhealthio/http-extraction-fundamentals'
import type { Array as Arr } from 'effect'
import { Data } from 'effect'

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
 * One file set's decode: its picked files, in the order they were picked, and
 * its sections and notes, every review key already namespaced by the set's
 * first picked file (`FormatDecode.keyPrefix`).
 */
interface Type {
  readonly pickedFiles: Arr.NonEmptyReadonlyArray<PickedFile.Type>
  readonly sections: readonly Section[]
  readonly notes: readonly string[]
}

/** `decoded`, a set's decode of already adopted resources, as `Adopted` sections. */
const ofAdopted = (
  pickedFiles: Arr.NonEmptyReadonlyArray<PickedFile.Type>,
  decoded: DecodedFile.DecodedFile
): Type => ({
  pickedFiles,
  sections: decoded.sections.map((section) =>
    Section.Adopted({ title: section.title, entries: section.resources })
  ),
  notes: decoded.notes,
})

export { ofAdopted, Section }
export type { Type }
