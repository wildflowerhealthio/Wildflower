import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Either, Schema } from 'effect'
import { type FhirResource, Observation, Patient } from 'fhir-r4/resources'
import type { ImportParseFailure, Preview } from 'importer-core'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  NO_COLLECTOR_HEADING,
  NOTHING_TO_IMPORT_HEADING,
  PREVIEW_HEADING,
  PreviewPanel,
} from './preview-panel.tsx'

/**
 * The preview view is pure — props in, DOM out — so it is driven directly, no
 * router or transport. The point under test is that every outcome of the read
 * half renders **distinctly**: a browser's HAR of an unknown site, a recognized
 * archive that matched nothing, a decode failure amid real resources, and a
 * healthy preview each reach their own role/text, and the confirm affordance
 * appears only when there is something to write.
 */

afterEach(cleanup)

describe('PreviewPanel', () => {
  it('renders a no-collector archive as its own state, with no confirm action', () => {
    render(
      <PreviewPanel
        preview={{ _tag: 'NoCollectorClaims', totalEntries: 42 }}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        confirming={false}
      />
    )

    expect(screen.getByRole('heading', { name: NO_COLLECTOR_HEADING })).toBeDefined()
    expect(screen.getByRole('status').textContent).toMatch(/Read 42 entries/)
    // Nothing to write, so no confirm — only a way back.
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined()
  })

  it('renders a claimed-but-empty archive distinctly from the no-collector one', () => {
    render(
      <PreviewPanel
        preview={previewOf({ resourcesByType: {}, unmatchedCount: 3 })}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        confirming={false}
      />
    )

    // A collector *did* claim — so this is not the no-collector heading…
    expect(screen.getByRole('heading', { name: NOTHING_TO_IMPORT_HEADING })).toBeDefined()
    expect(screen.queryByRole('heading', { name: NO_COLLECTOR_HEADING })).toBeNull()
    // …the collector and the unmatched count are both surfaced…
    expect(screen.getByText('fhir-r4')).toBeDefined()
    expect(screen.getByText(/3 other entries went unrecognized/)).toBeDefined()
    // …and still nothing to import.
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull()
  })

  it('surfaces parse failures as an alert listing the responses that could not be decoded', () => {
    const failure: ImportParseFailure = {
      url: 'https://r4.example.org/baseR4/Observation/bad',
      // The panel only reads `url`, but the type wants a real `ParseError` — a bad
      // decode makes one rather than casting a stand-in into the channel.
      error: anyParseError(),
    }
    render(
      <PreviewPanel
        preview={previewOf({
          resourcesByType: { Patient: [patient('pat-1')] },
          parseFailures: [failure],
        })}
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
        preview={previewOf({
          rootUrls: ['https://r4.example.org/baseR4'],
          resourcesByType: {
            Patient: [patient('pat-1')],
            Observation: [observation('obs-1'), observation('obs-2')],
          },
        })}
        onConfirm={onConfirm}
        onCancel={() => undefined}
        confirming={false}
      />
    )

    // The healthy heading, the detected collector and its source root, and the
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

  it('disables the confirm while a confirmed import is running', () => {
    render(
      <PreviewPanel
        preview={previewOf({ resourcesByType: { Patient: [patient('pat-1')] } })}
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

/** A genuine `ParseError`, produced by a decode that must fail. */
const anyParseError = (): ImportParseFailure['error'] => {
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
  readonly parseFailures?: readonly ImportParseFailure[]
}): Preview => ({
  _tag: 'Preview',
  collectorTag: 'fhir-r4',
  rootUrls: fields.rootUrls ?? ['https://r4.example.org/baseR4'],
  resourcesByType: fields.resourcesByType,
  parseFailures: fields.parseFailures ?? [],
  unmatchedCount: fields.unmatchedCount ?? 0,
  bodyAbsentCount: fields.bodyAbsentCount ?? 0,
  totalEntries: Object.values(fields.resourcesByType).flat().length,
})
