import {
  type FormatDecode,
  type PickedFile,
  type ReviewRow,
  Section,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'

import { type FormatKind, formatKinds } from './registry.ts'

/**
 * The groups a batch's reviewed records fall into: one per claimed format,
 * and one for the batch's linked records, which no format holds. A review key
 * is unique within a group, not across groups, so the server diff, the
 * preview and the write plan each scope a record by its group.
 *
 * @packageDocumentation
 */

/** The group the batch's linked records are reviewed in, beside the formats'. */
const LINKED = 'linked'

/** A group of the review: a format's, or the batch's linked records. */
type Key = FormatKind | typeof LINKED

/** Every group, in review order: the formats in registry order, then the linked records. */
const keys: readonly Key[] = [...formatKinds, LINKED]

/**
 * One group's rows to review in sections, beside its notes, the picked files
 * of it that yielded nothing reviewable, and the picks it was read from, in
 * pick order: what a re-decode reads again. The linked records' group was
 * read from no picks, so it has no unreadable one.
 */
interface Type {
  readonly sectionedList: SectionedList.Type<ReviewRow.Type>
  readonly notes: readonly string[]
  readonly unreadableFiles: readonly FormatDecode.UnreadableFile[]
  readonly files: readonly PickedFile.Type[]
}

/** The title of the linked records' one section. */
const LINKED_SECTION_TITLE = 'Linked records'

/** The linked records' group: `rows` in one section, no notes, no unreadable files, no picks. */
const linked = (rows: readonly ReviewRow.Type[]): Type => ({
  sectionedList: SectionedList.make([Section.make(LINKED_SECTION_TITLE, rows)]),
  notes: [],
  unreadableFiles: [],
  files: [],
})

/** Every row of `group`, in section order. */
const rows = (group: Type): readonly ReviewRow.Type[] => SectionedList.rows(group.sectionedList)

/**
 * Groups by key, a group present only when it takes part: a format's when
 * the format claimed a file, the linked records' when there are any.
 */
type Groups<K extends Key = Key> = { readonly [G in K]?: Type }

/**
 * Every group present in `groups`, keyed, in `order`.
 *
 * @param order - The keys to walk in the order wanted: {@link keys} for
 *   review order
 */
const entries = <K extends Key>(
  groups: Groups<K>,
  order: readonly K[]
): readonly (readonly [K, Type])[] =>
  order.flatMap((key) => {
    const group = groups[key]
    return group === undefined ? [] : [[key, group] as const]
  })

export { entries, keys, LINKED, linked, rows }
export type { Groups, Key, Type }
