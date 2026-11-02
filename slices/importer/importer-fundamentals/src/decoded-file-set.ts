/**
 * One file set as its format decoded it: the picks read together, and the
 * records read out of them, before the import stage makes them the device's.
 *
 * @packageDocumentation
 */
import type { SystemFamily } from '@wildflowerhealthio/http-extraction-fundamentals'
import type { Array as Arr } from 'effect'
import { Option } from 'effect'

import type * as DecodedFile from './decoded-file.ts'
import * as DecodedRecord from './decoded-record.ts'
import type * as PickedFile from './picked-file.ts'

/** One reviewed record: its review key, its title, and the record. */
interface Entry {
  readonly key: string
  readonly title: string
  readonly record: DecodedRecord.Type
}

/**
 * A titled group of records from one source batch.
 *
 * @remarks
 * `systemFamily` is the systems that batch keys each type in, which a
 * `FromSource` record's references are keyed in: one family per batch, not
 * per record. `None` for a section of `Adopted` records only, whose
 * references were keyed when they were adopted.
 */
interface Section {
  readonly title: string
  readonly systemFamily: Option.Option<SystemFamily.Type>
  readonly entries: readonly Entry[]
}

/**
 * One file set's decode: its members, in pick order, and its sections and
 * notes, every review key already namespaced by the set's first member
 * (`FormatDecode.keyPrefix`).
 */
interface Type {
  readonly members: Arr.NonEmptyReadonlyArray<PickedFile.Type>
  readonly sections: readonly Section[]
  readonly notes: readonly string[]
}

/** `decoded`, a set's decode of already adopted resources, as `Adopted` records. */
const ofAdopted = (
  members: Arr.NonEmptyReadonlyArray<PickedFile.Type>,
  decoded: DecodedFile.DecodedFile
): Type => ({
  members,
  sections: decoded.sections.map((section) => ({
    title: section.title,
    systemFamily: Option.none(),
    entries: section.resources.map(({ key, title, resource }) => ({
      key,
      title,
      record: DecodedRecord.Adopted({ resource }),
    })),
  })),
  notes: decoded.notes,
})

export { ofAdopted }
export type { Entry, Section, Type }
