import { cleanup, render, screen } from '@testing-library/react'
import type { BatchEntryOutcome, WriteIssue } from 'fhir-r4/clients'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { type BatchOutcome, type FileImportResult, importOutcome } from './import-outcome.ts'
import {
  COMPLETE_HEADING,
  ImportResults,
  PARTIAL_HEADING,
  SKIPPED_HEADING,
} from './import-results.tsx'

/**
 * The results view: every submitted resource grouped by response code in
 * foldable sections (failures open to their diagnostics, successes folded),
 * then the files with nothing to import. The source-file archive writes in the
 * same batch, so a failed archive is just another failure row — there is no
 * separate upload-failed section. Driven directly — a `BatchOutcome` in, DOM
 * out.
 */
afterEach(cleanup)

describe('ImportResults', () => {
  it('frames an all-success batch as complete and names each written resource under its status', () => {
    const batch: BatchOutcome = [
      importedFile('a', [ok('Patient/p1', '201 Created'), ok('Observation/o1', '201 Created')]),
    ]

    render(<ImportResults batch={batch} onStartOver={vi.fn()} />)

    expect(screen.getByRole('heading', { name: COMPLETE_HEADING })).toBeDefined()
    expect(screen.getByRole('status').textContent).toMatch(/Wrote 2 of 2/)
    expect(screen.getByText(/201 Created · 2 resources/)).toBeDefined()
    expect(screen.getByText('Patient/p1')).toBeDefined()
  })

  it('opens failure groups to the server diagnostics and sorts them before successes', () => {
    const batch: BatchOutcome = [
      importedFile('a', [
        ok('Patient/p1', '201 Created'),
        failed('Observation/o1', '422 Unprocessable Entity', [
          { severity: 'error', code: 'invariant', text: 'Reference Patient/x not found' },
        ]),
      ]),
    ]

    render(<ImportResults batch={batch} onStartOver={vi.fn()} />)

    expect(screen.getByRole('heading', { name: PARTIAL_HEADING })).toBeDefined()
    // The failure's diagnostics are visible without a click (its section is open).
    expect(screen.getByText('Reference Patient/x not found')).toBeDefined()
    // Failures sort before successes: the section summaries in DOM order.
    const summaries = screen.getAllByText(/· \d+ resource/)
    expect(summaries[0]?.textContent).toMatch(/422 Unprocessable Entity/)
    expect(summaries[1]?.textContent).toMatch(/201 Created/)
  })

  it('renders a failed source-file archive as an ordinary failure row, framing the batch as partial', () => {
    const batch: BatchOutcome = [
      importedFile('b', [
        failed('DocumentReference/archive-1', '422 Unprocessable Entity', [
          { severity: 'error', code: 'invariant', text: 'archive rejected by the server' },
        ]),
        ok('Observation/o1', '201 Created'),
      ]),
    ]

    render(<ImportResults batch={batch} onStartOver={vi.fn()} />)

    expect(screen.getByRole('heading', { name: PARTIAL_HEADING })).toBeDefined()
    // The archive's failure is a normal per-entry row, not a separate section.
    expect(screen.getByText('DocumentReference/archive-1')).toBeDefined()
    expect(screen.getByText('archive rejected by the server')).toBeDefined()
  })

  it('notes a file that had nothing to import without framing the batch as partial', () => {
    const batch: BatchOutcome = [
      importedFile('a', [ok('Patient/p1', '201 Created')]),
      { _tag: 'skipped', id: 'c', fileName: 'c.har', reason: 'nothing' },
    ]

    render(<ImportResults batch={batch} onStartOver={vi.fn()} />)

    // A skip alone is not a failure — the batch is still complete.
    expect(screen.getByRole('heading', { name: COMPLETE_HEADING })).toBeDefined()
    expect(screen.getByRole('region', { name: SKIPPED_HEADING })).toBeDefined()
    expect(screen.getByText(/Nothing here to import/)).toBeDefined()
  })
})

// Helpers

/** A 2xx per-entry outcome for `Type/id`. */
const ok = (typeId: string, status: string): BatchEntryOutcome => entry(typeId, status, true, [])

/** A non-2xx per-entry outcome for `Type/id`, carrying its server issues. */
const failed = (typeId: string, status: string, issues: readonly WriteIssue[]): BatchEntryOutcome =>
  entry(typeId, status, false, issues)

/** One `BatchEntryOutcome` for `Type/id`. */
const entry = (
  typeId: string,
  status: string,
  isOk: boolean,
  issues: readonly WriteIssue[]
): BatchEntryOutcome => {
  const [label = 'Patient', id = typeId] = typeId.split('/')
  return { target: { label, id }, status, ok: isOk, issues }
}

/** An `imported` file result carrying the given per-entry outcomes. */
const importedFile = (id: string, entries: readonly BatchEntryOutcome[]): FileImportResult => ({
  _tag: 'imported',
  id,
  fileName: `${id}.har`,
  outcome: importOutcome(entries.length, `DocumentReference/${id}`, `${id}.har`, entries),
})
