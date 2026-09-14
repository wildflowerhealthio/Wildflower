import * as fc from 'fast-check'
import type { BatchEntryOutcome } from 'fhir-r4/clients'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import {
  allResults,
  type FileImportResult,
  groupResultsByStatus,
  importOutcome,
  isPartialBatch,
  isPartialOutcome,
  summarizeBatch,
  writtenCount,
} from './import-outcome.ts'

/**
 * The pure fold from a file's per-entry write outcomes to its tally, plus the
 * batch-wide grouping the results view reads. The `collectImportSummary`
 * semantics hold: **any** non-2xx makes the import partial, `written` is exactly
 * the count of accepted entries, and every result is tagged with its file and
 * provenance so the batch-wide view can group by status while still naming rows.
 */

describe('importOutcome', () => {
  test('property: written = accepted entries, and any failure ⇒ partial', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 30 }),
        fc.nat({ max: 30 }),
        fc.string({ minLength: 1 }),
        (okCount, failCount, sourceRef) => {
          const entries = entriesOf(okCount, failCount)
          const outcome = importOutcome(okCount + failCount, sourceRef, 'session.har', entries)

          expect(outcome.attempted).toBe(okCount + failCount)
          expect(writtenCount(outcome)).toBe(okCount)
          expect(outcome.sourceRef).toBe(sourceRef)
          expect(isPartialOutcome(outcome)).toBe(failCount > 0)
          // Every result is tagged with its file and provenance for the batch view.
          expect(
            outcome.results.every(
              (result) => result.fileName === 'session.har' && result.sourceRef === sourceRef
            )
          ).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('is complete when every entry is 2xx, partial with any non-2xx', () => {
    expect(
      isPartialOutcome(importOutcome(2, 'DocumentReference/a', 'a.har', entriesOf(2, 0)))
    ).toBe(false)
    expect(
      isPartialOutcome(importOutcome(2, 'DocumentReference/a', 'a.har', entriesOf(1, 1)))
    ).toBe(true)
  })
})

describe('summarizeBatch and isPartialBatch', () => {
  it('sums written, attempted, and excluded, and counts imported against total files', () => {
    const batch: FileImportResult[] = [
      imported('a', 3, 0, 2),
      imported('b', 1, 1, 0),
      { _tag: 'uploadFailed', id: 'c', fileName: 'c.har', error: new Error('boom') },
      { _tag: 'skipped', id: 'd', fileName: 'd.har', reason: 'nothing' },
    ]
    const summary = summarizeBatch(batch)
    expect(summary.written).toBe(4) // 3 + 1
    expect(summary.attempted).toBe(5) // 3 + 2
    expect(summary.excluded).toBe(2)
    expect(summary.importedFiles).toBe(2)
    expect(summary.totalFiles).toBe(4)
  })

  it('is partial when any file upload-failed or wrote partially, complete otherwise', () => {
    expect(isPartialBatch([imported('a', 3, 0)])).toBe(false)
    // A skipped file alone is not a failure — an empty review is ordinary data.
    expect(
      isPartialBatch([
        imported('a', 3, 0),
        { _tag: 'skipped', id: 'b', fileName: 'b.har', reason: 'nothing' },
      ])
    ).toBe(false)
    expect(isPartialBatch([imported('a', 2, 1)])).toBe(true)
    expect(
      isPartialBatch([
        imported('a', 3, 0),
        { _tag: 'uploadFailed', id: 'b', fileName: 'b.har', error: new Error('boom') },
      ])
    ).toBe(true)
  })
})

describe('groupResultsByStatus', () => {
  it('groups across the whole batch and sorts failures first, then by ascending code', () => {
    const batch: FileImportResult[] = [
      fileWith('a', [
        outcome('Patient/p1', '201 Created', true),
        outcome('Observation/o1', '404 Not Found', false),
      ]),
      fileWith('b', [
        outcome('Patient/p2', '200 OK', true),
        outcome('Observation/o2', '422 Unprocessable Entity', false),
        outcome('Observation/o3', '404 Not Found', false),
      ]),
    ]

    const groups = groupResultsByStatus(batch)

    // Failures first (404 before 422), then successes (200 before 201).
    expect(groups.map((group) => group.status)).toEqual([
      '404 Not Found',
      '422 Unprocessable Entity',
      '200 OK',
      '201 Created',
    ])
    // The 404 group collects that status from every file, in encounter order.
    expect(groups[0]?.results.map((result) => result.target.id)).toEqual(['o1', 'o3'])
    expect(groups[0]?.ok).toBe(false)
  })

  it('flattens only the imported files, skipping upload-failed and skipped files', () => {
    const batch: FileImportResult[] = [
      fileWith('a', [outcome('Patient/p1', '201 Created', true)]),
      { _tag: 'uploadFailed', id: 'b', fileName: 'b.har', error: new Error('boom') },
      { _tag: 'skipped', id: 'c', fileName: 'c.har', reason: 'nothing' },
    ]
    expect(allResults(batch)).toHaveLength(1)
    expect(groupResultsByStatus(batch).map((group) => group.status)).toEqual(['201 Created'])
  })
})

// Helpers

/** `okCount` accepted entries then `failCount` rejected ones, shaped like the sink's records. */
const entriesOf = (okCount: number, failCount: number): readonly BatchEntryOutcome[] => [
  ...Array.from({ length: okCount }, (_, index): BatchEntryOutcome => ({
    target: { label: 'Observation', id: `ok-${index}` },
    status: '201 Created',
    ok: true,
    issues: [],
  })),
  ...Array.from({ length: failCount }, (_, index): BatchEntryOutcome => ({
    target: { label: 'Observation', id: `bad-${index}` },
    status: '422 Unprocessable Entity',
    ok: false,
    issues: [{ severity: 'error', code: 'invariant', text: `entry ${index} rejected` }],
  })),
]

/** One `BatchEntryOutcome` for `Type/id` with the given status. */
const outcome = (typeId: string, status: string, ok: boolean): BatchEntryOutcome => {
  const [label = 'Observation', id = typeId] = typeId.split('/')
  return { target: { label, id }, status, ok, issues: [] }
}

/** An `imported` file result writing `okCount` accepted and `failCount` rejected resources. */
const imported = (
  id: string,
  okCount: number,
  failCount: number,
  excluded = 0
): FileImportResult => ({
  _tag: 'imported',
  id,
  fileName: `${id}.har`,
  outcome: importOutcome(
    okCount + failCount,
    `DocumentReference/${id}`,
    `${id}.har`,
    entriesOf(okCount, failCount),
    excluded
  ),
})

/** An `imported` file result carrying the given explicit per-entry outcomes. */
const fileWith = (id: string, entries: readonly BatchEntryOutcome[]): FileImportResult => ({
  _tag: 'imported',
  id,
  fileName: `${id}.har`,
  outcome: importOutcome(entries.length, `DocumentReference/${id}`, `${id}.har`, entries),
})
