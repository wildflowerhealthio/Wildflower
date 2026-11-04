/**
 * One file set as its format decoded it: the picked files read together, and
 * the records read out of them, before the import stage makes them the
 * device's.
 *
 * @packageDocumentation
 */
import {
  adoptUnderKey,
  type ResourceWithSourceId,
  withSourceId,
} from '@wildflowerhealthio/fhir-r4-adoption'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResource, FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import type { SystemFamily } from '@wildflowerhealthio/http-extraction-fundamentals'
import { type Array as Arr, Data, MutableHashMap, Option } from 'effect'

import type * as DecodedFile from './decoded-file.ts'
import type * as PickedFile from './picked-file.ts'

/**
 * One record of a `FromSource` section: its review key and title, and the
 * record as its source gave it beside the `system` and `sourceId` it is
 * adopted under.
 */
interface FromSourceEntry {
  readonly key: string
  readonly title: string
  readonly system: string
  readonly sourceId: string
  readonly resource: FhirResource
}

/**
 * A titled group of records from one source batch, as the import stage
 * receives it: every record already adopted, or each beside the key it is
 * adopted under. Every entry carries its review key and its title.
 *
 * @remarks
 * - `Adopted`: every record already the device's own, with its `wf-` id; the
 *   import stage keeps each as it is. What the HAR decoders still return,
 *   through `DecodeFunction.fromAdopted`; deleted once they return
 *   `FromSource` sections.
 * - `FromSource`: each record as its source gave it, beside its key less its
 *   type: the `system` its source id is unique in, an absolute URI, and the
 *   `sourceId` in it. A decoder builds one per source batch: LifeLabs' and
 *   DICOM's under a `FixedAcrossResourceTypes` family. Each record's `system`
 *   and `sourceId` are what `fhir-r4-adoption`'s `withSourceId` reads: its own
 *   id under `SystemFamily.systemFor(family, type)`, else
 *   `CONTENT_DIGEST_SYSTEM` and a digest of its content. The import stage
 *   adopts each (`adoptUnderKey`), its references keyed in the section's
 *   `systemFamily`: one family per batch, not per record.
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
    readonly entries: readonly FromSourceEntry[]
  }
}>

const Section = Data.taggedEnum<Section>()

/** A record's review row: the key it is selected and edited under, and its title. */
interface ReviewLabel {
  readonly key: string
  readonly title: string
}

/**
 * One source batch's records as a `FromSource` section, the batch's system
 * family given once: each record beside its source id in that family
 * (`fhir-r4-adoption`'s `withSourceId`), labelled by `labelOf`.
 *
 * @param section.systemFamily - The systems the batch keys each type in
 * @param section.title - The section's title
 * @param section.resources - The batch's records, as its source gave them
 * @param section.labelOf - Each record's review key and title, given it
 *   beside the `system` and `sourceId` it is adopted under
 */
const fromSourceSection = <TResource extends FhirResource>({
  systemFamily,
  title,
  resources,
  labelOf,
}: {
  readonly systemFamily: SystemFamily.Type
  readonly title: string
  readonly resources: readonly TResource[]
  readonly labelOf: (record: ResourceWithSourceId & { readonly resource: TResource }) => ReviewLabel
}): Section => {
  const keyed = withSourceId(systemFamily)
  return Section.FromSource({
    title,
    systemFamily,
    entries: resources.map((resource): FromSourceEntry => {
      const record = { ...keyed(resource), resource }
      return { ...labelOf(record), ...record }
    }),
  })
}

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

/** `pickedFile`, identifying as nothing: a picked file of a format whose files do not name themselves. */
const unidentified = (pickedFile: PickedFile.Type): PickedFileIdentity => ({
  pickedFile,
  identifiedAs: Option.none(),
})

/**
 * Prefix every review key in `sections`, so one file set's keys cannot collide
 * with another's once the batch merges their sections.
 *
 * @param prefix - The set's key namespace, from `FormatDecode.keyPrefix`
 */
const namespaceKeys = (sections: readonly Section[], prefix: string): readonly Section[] => {
  const prefixed = <TEntry extends { readonly key: string }>(
    entries: readonly TEntry[]
  ): readonly TEntry[] => entries.map((entry) => ({ ...entry, key: `${prefix}${entry.key}` }))
  return sections.map(
    Section.$match({
      Adopted: ({ title, entries }) => Section.Adopted({ title, entries: prefixed(entries) }),
      FromSource: ({ title, systemFamily, entries }) =>
        Section.FromSource({ title, systemFamily, entries: prefixed(entries) }),
    })
  )
}

/** The one adopter of each system family, built the first time a section asks for it. */
type AdopterOf = (systemFamily: SystemFamily.Type) => ReturnType<typeof adoptUnderKey>

/** {@link AdopterOf}, each family's `adoptUnderKey` built once and reused. */
const memoisedAdopterOf = (): AdopterOf => {
  const adopters = MutableHashMap.empty<SystemFamily.Type, ReturnType<typeof adoptUnderKey>>()
  return (systemFamily) =>
    Option.getOrElse(MutableHashMap.get(adopters, systemFamily), () => {
      const adopter = adoptUnderKey(systemFamily)
      MutableHashMap.set(adopters, systemFamily, adopter)
      return adopter
    })
}

/**
 * One section's records, adopted: a `FromSource` section's each under its
 * key, its references keyed in the section's system family; an `Adopted`
 * section's as they are.
 */
const adoptSection = (adopterOf: AdopterOf): ((section: Section) => DecodedFile.Section) =>
  Section.$match({
    Adopted: ({ title, entries }): DecodedFile.Section => ({ title, resources: entries }),
    FromSource: ({ title, systemFamily, entries }): DecodedFile.Section => {
      const adoptEntry = adopterOf(systemFamily)
      return {
        title,
        resources: entries.map((entry) => ({
          key: entry.key,
          title: entry.title,
          resource: adoptEntry(entry),
        })),
      }
    },
  })

/**
 * A decode's sections adopted, each by {@link adoptSection}, beside its notes:
 * how the import stage makes a file set's records the device's own, before it
 * mints source files, links and stamps.
 *
 * @remarks
 * Sections that share a system family share one `adoptUnderKey`, so its parsed
 * systems are cached across them.
 */
const adopt = (decoded: Pick<Type, 'sections' | 'notes'>): DecodedFile.DecodedFile => ({
  sections: decoded.sections.map(adoptSection(memoisedAdopterOf())),
  notes: decoded.notes,
})

export { adopt, fromSourceSection, namespaceKeys, Section, unidentified }
export type { FromSourceEntry, PickedFileIdentity, ReviewLabel, Type }
