import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { SourceFileRow } from '../queries/source-files.ts'
import { groupSourceFiles } from './group-source-files.ts'

const row = (id: string, related: string | null = null): SourceFileRow => ({
  id,
  format: 'dicom',
  title: `${id}.dcm`,
  creation: DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z')),
  related,
})

describe('groupSourceFiles', () => {
  it('leaves a source file that names no unit on its own', () => {
    expect(groupSourceFiles([row('a'), row('b')])).toEqual([
      { _tag: 'file', row: row('a') },
      { _tag: 'file', row: row('b') },
    ])
  })

  it('collapses the files of one unit into one entry, at the first one’s position', () => {
    const entries = groupSourceFiles([
      row('a', 'ImagingStudy/s1'),
      row('b'),
      row('c', 'ImagingStudy/s1'),
    ])
    expect(entries).toEqual([
      {
        _tag: 'unit',
        related: 'ImagingStudy/s1',
        rows: [row('a', 'ImagingStudy/s1'), row('c', 'ImagingStudy/s1')],
      },
      { _tag: 'file', row: row('b') },
    ])
  })

  it('leaves a unit of one file as an ordinary row', () => {
    // A heading over a single row states nothing the row does not, and the
    // whole-unit action would be the one already on it.
    expect(groupSourceFiles([row('a', 'ImagingStudy/s1')])).toEqual([
      { _tag: 'file', row: row('a', 'ImagingStudy/s1') },
    ])
  })

  it('keeps two units apart', () => {
    const entries = groupSourceFiles([
      row('a', 'ImagingStudy/s1'),
      row('b', 'ImagingStudy/s2'),
      row('c', 'ImagingStudy/s1'),
      row('d', 'ImagingStudy/s2'),
    ])
    expect(entries.map((entry) => (entry._tag === 'unit' ? entry.related : entry.row.id))).toEqual([
      'ImagingStudy/s1',
      'ImagingStudy/s2',
    ])
  })

  it('lists every row exactly once, in server order (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.uuid(), fc.option(fc.constantFrom('s1', 's2', 's3'), { nil: null })), {
          minLength: 0,
          maxLength: 12,
        }),
        (pairs) => {
          const rows = pairs.map(([id, study], index) =>
            row(`${index}-${id}`, study === null ? null : `ImagingStudy/${study}`)
          )
          const listed = groupSourceFiles(rows).flatMap((entry) =>
            entry._tag === 'file' ? [entry.row] : entry.rows
          )
          // Same rows, and every unit's members keep their relative order —
          // a grouping that dropped or duplicated one would be a list the
          // reviewer cannot trust.
          expect(listed.map((one) => one.id).toSorted()).toEqual(
            rows.map((one) => one.id).toSorted()
          )
          const studyRows = rows.filter((one) => one.related !== null).map((one) => one.id)
          expect(
            listed
              .filter((one) => one.related !== null)
              .map((one) => one.id)
              .toSorted()
          ).toEqual(studyRows.toSorted())
        }
      ),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })
})
