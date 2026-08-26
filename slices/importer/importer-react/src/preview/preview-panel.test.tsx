import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Either, Schema } from 'effect'
import { type FhirResource, Observation, Patient } from 'fhir-r4/resources'
import type { ImportPreview } from 'importer-core'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { LOCAL_SOURCE, type PickedHar } from '../sources/picked-har.ts'
import { NOTHING_TO_IMPORT_HEADING, PREVIEW_HEADING, PreviewPanel } from './preview-panel.tsx'
import type { ReadEntry } from './use-import-run.ts'

/**
 * The preview view is pure — props in, DOM out — so it is driven directly, no
 * router or transport. A pick is a batch of one or more files, so the point under
 * test is that every file's outcome renders **distinctly** — a browser's HAR of
 * an unknown site, a recognized archive that matched nothing, a decode failure
 * amid real resources, an unreadable file, and a healthy preview — under one
 * shared confirm that appears only when at least one file has something to write.
 */

afterEach(cleanup)

describe('PreviewPanel', () => {
  it('renders a no-source file as its own state, with no confirm action', () => {
    render(
      <PreviewPanel
        entries={[readEntry({ _tag: 'NoSourceClaims', totalEntries: 42 })]}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        confirming={false}
      />
    )

    // The batch has nothing to write, so the top heading says so and the file's
    // own row explains why: recognized by nobody.
    expect(screen.getByRole('heading', { name: NOTHING_TO_IMPORT_HEADING })).toBeDefined()
    expect(screen.getByRole('status').textContent).toMatch(/Read 42 entries/)
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined()
  })

  it('renders a claimed-but-empty file distinctly from the no-source one', () => {
    render(
      <PreviewPanel
        entries={[readEntry(previewOf({ resourcesByType: {}, unmatchedCount: 3 }))]}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        confirming={false}
      />
    )

    // An importer *did* claim — the importer and unmatched count are surfaced,
    // with a distinct message from the no-source one, and still nothing to write.
    expect(screen.getByRole('heading', { name: NOTHING_TO_IMPORT_HEADING })).toBeDefined()
    expect(screen.getByText('fhir-r4')).toBeDefined()
    expect(screen.getByText(/recognized this archive, but matched no resources/)).toBeDefined()
    expect(screen.getByText(/3 other entries went unrecognized/)).toBeDefined()
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull()
  })

  it('surfaces parse failures as an alert listing the responses that could not be decoded', () => {
    const failure: ImportPreview.ImportParseFailure = {
      url: 'https://r4.example.org/baseR4/Observation/bad',
      // The panel only reads `url`, but the type wants a real `ParseError` — a bad
      // decode makes one rather than casting a stand-in into the channel.
      error: anyParseError(),
    }
    render(
      <PreviewPanel
        entries={[
          readEntry(
            previewOf({
              resourcesByType: { Patient: [patient('pat-1')] },
              parseFailures: [failure],
            })
          ),
        ]}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        confirming={false}
      />
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/could not be decoded/)
    expect(alert.textContent).toContain('https://r4.example.org/baseR4/Observation/bad')
  })

  it('renders a healthy preview with per-type counts, roots, and a confirm that opts in', async () => {
    const onConfirm = vi.fn()
    render(
      <PreviewPanel
        entries={[
          readEntry(
            previewOf({
              rootUrls: ['https://r4.example.org/baseR4'],
              resourcesByType: {
                Patient: [patient('pat-1')],
                Observation: [observation('obs-1'), observation('obs-2')],
              },
            })
          ),
        ]}
        onConfirm={onConfirm}
        onCancel={() => undefined}
        confirming={false}
      />
    )

    // The healthy heading, the detected importer and its source root, and the
    // per-type sections with counts and rows.
    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    expect(screen.getByText('fhir-r4')).toBeDefined()
    expect(screen.getByText('https://r4.example.org/baseR4')).toBeDefined()
    expect(screen.getByRole('heading', { name: /Patient/ })).toBeDefined()
    expect(screen.getByRole('heading', { name: /Observation/ })).toBeDefined()
    expect(screen.getByText('pat-1')).toBeDefined()
    expect(screen.getByText('obs-1')).toBeDefined()
    expect(screen.getByText('obs-2')).toBeDefined()

    // The confirm names the total to write, and opting in calls back — it does not
    // itself write.
    await userEvent.click(screen.getByRole('button', { name: 'Import 3 resources' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('sums a mixed batch: one confirm for the writable files, each file rendered', () => {
    render(
      <PreviewPanel
        entries={[
          readEntry(previewOf({ resourcesByType: { Patient: [patient('pat-1')] } }), 'a.har'),
          readEntry({ _tag: 'NoSourceClaims', totalEntries: 7 }, 'b.har'),
          readEntry(
            previewOf({ resourcesByType: { Observation: [observation('obs-1')] } }),
            'c.har'
          ),
        ]}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        confirming={false}
      />
    )

    // Two writable files sum to two resources on one confirm; every file shows.
    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    expect(screen.getByText(/2 resources across 3 files/)).toBeDefined()
    expect(screen.getByRole('region', { name: 'a.har' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'b.har' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'c.har' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Import 2 resources' })).toBeDefined()
  })

  it('reports an unreadable file against its name without sinking a writable sibling', () => {
    render(
      <PreviewPanel
        entries={[
          { _tag: 'unreadable', id: 'u', picked: pickedHar('broken.har'), error: anyParseError() },
          readEntry(previewOf({ resourcesByType: { Patient: [patient('pat-1')] } }), 'good.har'),
        ]}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        confirming={false}
      />
    )

    expect(screen.getByText(/could not be read as a HAR/)).toBeDefined()
    // The readable sibling still offers its confirm.
    expect(screen.getByRole('button', { name: 'Import 1 resource' })).toBeDefined()
  })

  it('disables the confirm while a confirmed import is running', () => {
    render(
      <PreviewPanel
        entries={[readEntry(previewOf({ resourcesByType: { Patient: [patient('pat-1')] } }))]}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        confirming
      />
    )

    const confirm = screen.getByRole('button', { name: /Importing…/ })
    expect(confirm.getAttribute('disabled')).not.toBeNull()
  })
})

// Helpers

/** A `local` pick with the given name — the shape a read entry carries. */
const pickedHar = (fileName: string): PickedHar => ({
  fileName,
  text: '{}',
  source: LOCAL_SOURCE,
})

/** A `read` {@link ReadEntry} wrapping one preview, named for the batch's file rows. */
const readEntry = (preview: ImportPreview.ImportPreview, fileName = 'session.har'): ReadEntry => ({
  _tag: 'read',
  id: fileName,
  picked: pickedHar(fileName),
  preview,
})

/** A genuine `ParseError`, produced by a decode that must fail. */
const anyParseError = (): ImportPreview.ImportParseFailure['error'] => {
  const result = Schema.decodeUnknownEither(Schema.Number)('not a number')
  if (Either.isRight(result)) throw new Error('unreachable: decode of a non-number succeeded')
  return result.left
}

/** A schema-valid `Patient` with a known id — the panel reads its id and type. */
const patient = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

/** A schema-valid `Observation` with a known id. */
const observation = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Observation.Schema)({
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { text: 'Body Weight' },
  })

/** A claimed `Preview` with the given fields; the rest are sensible empties. */
const previewOf = (fields: {
  readonly resourcesByType: Readonly<Record<string, readonly FhirResource[]>>
  readonly rootUrls?: readonly string[]
  readonly unmatchedCount?: number
  readonly bodyAbsentCount?: number
  readonly parseFailures?: readonly ImportPreview.ImportParseFailure[]
}): ImportPreview.Preview => ({
  _tag: 'Preview',
  sourceTag: 'fhir-r4',
  rootUrls: fields.rootUrls ?? ['https://r4.example.org/baseR4'],
  resourcesByType: fields.resourcesByType,
  parseFailures: fields.parseFailures ?? [],
  unmatchedCount: fields.unmatchedCount ?? 0,
  bodyAbsentCount: fields.bodyAbsentCount ?? 0,
  totalEntries: Object.values(fields.resourcesByType).flat().length,
})
