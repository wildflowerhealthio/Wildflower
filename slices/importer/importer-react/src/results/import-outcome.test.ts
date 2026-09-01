import * as fc from 'fast-check'
import type { PersistFailure } from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import {
  type FileImportResult,
  importOutcome,
  isPartialBatch,
  isPartialOutcome,
  summarizeBatch,
} from './import-outcome.ts'

/**
 * The pure fold from a written count + its failures to the results tally. The
 * one property that matters is the `collectImportSummary` semantics: **any**
 * failure makes the whole import partial, `written` is exactly the attempted
 * count minus the failures, and the failure list is carried verbatim — never a
 * fraction, a threshold, or a re-count off the wire.
 */

describe('importOutcome', () => {
  test('property: written = attempted − failures, and any failure ⇒ partial', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 30 }),
        fc.nat({ max: 30 }),
        fc.string({ minLength: 1 }),
        (attempted, failureCount, sourceRef) => {
          const failures = failuresOf(failureCount)
          const outcome = importOutcome(attempted, sourceRef, failures)

          expect(outcome.attempted).toBe(attempted)
          expect(outcome.written).toBe(attempted - failureCount)
          expect(outcome.failures).toBe(failures)
          expect(outcome.sourceRef).toBe(sourceRef)
          expect(isPartialOutcome(outcome)).toBe(failureCount > 0)
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('is complete with an empty failure list, partial with any failure', () => {
    expect(isPartialOutcome(importOutcome(2, 'DocumentReference/a', []))).toBe(false)
    expect(isPartialOutcome(importOutcome(2, 'DocumentReference/a', failuresOf(1)))).toBe(true)
  })
})

/**
 * The batch fold across a whole set of files. The `collectImportSummary`
 * semantics lift to the batch: any file whose upload failed or whose resources
 * partly failed makes the whole batch partial, while `skipped` files (nothing to
 * write) never do; the summary sums written/attempted and counts imported vs.
 * total files.
 */
describe('summarizeBatch and isPartialBatch', () => {
  it('sums written and attempted, and counts imported against total files', () => {
    const batch: FileImportResult[] = [
      imported('a', 3, 0),
      imported('b', 2, 1),
      { _tag: 'uploadFailed', id: 'c', fileName: 'c.har', error: new Error('boom') },
      { _tag: 'skipped', id: 'd', fileName: 'd.har', reason: 'nothing' },
    ]
    const summary = summarizeBatch(batch)
    expect(summary.written).toBe(4) // 3 + 1
    expect(summary.attempted).toBe(5) // 3 + 2
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
    expect(isPartialBatch([imported('a', 3, 1)])).toBe(true)
    expect(
      isPartialBatch([
        imported('a', 3, 0),
        { _tag: 'uploadFailed', id: 'b', fileName: 'b.har', error: new Error('boom') },
      ])
    ).toBe(true)
  })
})

// Helpers

/** An `imported` file result writing `attempted` resources with `failureCount` failures. */
const imported = (id: string, attempted: number, failureCount: number): FileImportResult => ({
  _tag: 'imported',
  id,
  fileName: `${id}.har`,
  outcome: importOutcome(attempted, `DocumentReference/${id}`, failuresOf(failureCount)),
})

/** `count` distinct write failures, shaped like the write sink's own records. */
const failuresOf = (count: number): readonly PersistFailure[] =>
  Array.from({ length: count }, (_, index) => ({
    failed: { label: 'Observation', id: `obs-${index}` },
    cause: `write ${index} rejected`,
  }))
