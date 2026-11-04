/**
 * One file set as its format decoded it: the picked files read together, and
 * the records read out of them, before the import stage makes them the
 * device's.
 *
 * @packageDocumentation
 */
import {
  adopt as adoptRecord,
  DetachedResource,
  randomResourceId,
} from '@wildflowerhealthio/fhir-r4-adoption'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { type Array as Arr, Option } from 'effect'

import type * as DecodedFile from './decoded-file.ts'
import type * as PickedFile from './picked-file.ts'

/**
 * One record of a section: its review key and title, and the record as its
 * source gave it, detached (`fhir-r4-adoption`'s `DetachedResource`): no id,
 * keyed by its first identifier, naming every other record it decoded by a
 * logical reference.
 */
interface Entry {
  readonly key: string
  readonly title: string
  readonly resource: DetachedResource.Type
}

/**
 * A titled group of records from one source batch, as the import stage
 * receives it: each record detached, beside its review key and title.
 *
 * @remarks
 * A decoder builds one per batch it reads: LifeLabs one per report, DICOM one
 * per study, the HAR importer one per response URL. Each decoder detaches its
 * records itself (`fhir-r4-adoption`'s `detach`, under the system family its
 * source's ids belong to), so a section carries no family: everything the
 * import stage needs to adopt a record is on the record.
 *
 * A separate type from `DecodedFile.Section`, the same records adopted: the
 * two differ in what their records are, and every reader of a decoded file
 * reads `resources` off it.
 *
 * The section listing a set's source files is built by the import stage,
 * never decoded.
 */
interface Section {
  readonly title: string
  readonly entries: readonly Entry[]
}

/**
 * A record's review title: the reference the import stage writes it under,
 * `<Type>/<id>`, the id its key derives ({@link DetachedResource.keyedIdOf});
 * for a keyless record, whose id is only minted at import, its type and its
 * review key, `<Type> (<review key>)`.
 *
 * @param resource - The detached record
 * @param reviewKey - Its review key within its section, before the set's
 *   prefix: stable across a settings re-decode, as the title has to be
 */
const writtenReferenceTitle = (resource: DetachedResource.Type, reviewKey: string): string =>
  Option.match(DetachedResource.keyedIdOf(resource), {
    onSome: (id) => `${resource.resourceType}/${id}`,
    onNone: () => `${resource.resourceType} (${reviewKey})`,
  })

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
const namespaceKeys = (sections: readonly Section[], prefix: string): readonly Section[] =>
  sections.map(({ title, entries }) => ({
    title,
    entries: entries.map((entry) => ({ ...entry, key: `${prefix}${entry.key}` })),
  }))

/**
 * A decode's sections adopted beside its notes: how the import stage makes a
 * file set's records the device's own, before it mints source files, links
 * and stamps.
 *
 * @param decoded - The set's sections and notes
 * @param mintId - Mints the id of a keyless record; random outside tests
 *
 * @remarks
 * Every record goes through one `fhir-r4-adoption` `adopt` over the whole set,
 * as a FHIR server processes one transaction bundle: a keyed record lands on
 * the id its key derives and a keyless one on a minted id, and a logical
 * reference resolves when the record it names by key is in the set, whichever
 * section holds it (`DetachedResource.storedReferencesOf`). One that names a
 * record the set does not hold stays logical, for the identity map.
 */
const adopt = (
  decoded: Pick<Type, 'sections' | 'notes'>,
  mintId: () => string = randomResourceId
): DecodedFile.DecodedFile => {
  const adoptEntry = adoptRecord({
    storedReferences: DetachedResource.storedReferencesOf(
      decoded.sections.flatMap(({ entries }) => entries.map(({ resource }) => resource))
    ),
    mintId,
  })
  return {
    sections: decoded.sections.map(({ title, entries }) => ({
      title,
      resources: entries.map(({ key, title: entryTitle, resource }) => ({
        key,
        title: entryTitle,
        resource: adoptEntry(resource),
      })),
    })),
    notes: decoded.notes,
  }
}

export { adopt, namespaceKeys, unidentified, writtenReferenceTitle }
export type { Entry, PickedFileIdentity, Section, Type }
