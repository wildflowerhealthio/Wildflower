/**
 * Collapsing the uploaded-source-file list's rows into the units they were
 * read as.
 *
 * @remarks
 * A group format stores one archive per file and links each to the resource
 * they were read into (`SourceFileRow.related`). Listed flat, a twelve-file
 * DICOM study is twelve rows that say nothing about being one study — and
 * re-picking it means picking twelve rows one at a time, each of which
 * re-imports as a one-file study. Grouping is what lets the list name the
 * unit and offer it as one pick.
 *
 * Pure, and over the rows already loaded: paging can split a unit across
 * pages, in which case its later files join the group as those pages load.
 *
 * @packageDocumentation
 */

import type { SourceFileRow } from '../queries/source-files.ts'

/**
 * One entry of the rendered list: a source file that stands alone, or the
 * files of one unit.
 *
 * @remarks
 * A unit of *one* file is a `file` entry, not a one-row `unit`: a heading
 * over a single row states nothing the row does not, and "use all 1 file as
 * source" is the action already on it.
 */
type ListEntry =
  | { readonly _tag: 'file'; readonly row: SourceFileRow }
  | {
      readonly _tag: 'unit'
      /** The resource every row of this group names — the group's identity. */
      readonly related: string
      /** The unit's files, in the order the server listed them. */
      readonly rows: readonly SourceFileRow[]
    }

/**
 * Collapse rows that name the same resource into one entry.
 *
 * @param rows - The source files listed so far, in server order
 * @returns One entry per standalone file and per multi-file unit, each at the
 *   position of its first row
 */
const groupSourceFiles = (rows: readonly SourceFileRow[]): readonly ListEntry[] => {
  const byRelated = new Map<string, SourceFileRow[]>()
  for (const row of rows) {
    if (row.related === null) continue
    const members = byRelated.get(row.related)
    if (members === undefined) byRelated.set(row.related, [row])
    else members.push(row)
  }

  const emitted = new Set<string>()
  const entries: ListEntry[] = []
  for (const row of rows) {
    const members = row.related === null ? undefined : byRelated.get(row.related)
    if (row.related === null || members === undefined || members.length < 2) {
      entries.push({ _tag: 'file', row })
      continue
    }
    if (emitted.has(row.related)) continue
    emitted.add(row.related)
    entries.push({ _tag: 'unit', related: row.related, rows: members })
  }
  return entries
}

export { groupSourceFiles }
export type { ListEntry }
