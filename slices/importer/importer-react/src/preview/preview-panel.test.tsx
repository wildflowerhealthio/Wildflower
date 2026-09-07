import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DateTime, Effect, Either, Option, type ParseResult, Schema } from 'effect'
import { ReviewBody } from 'har-importer-react'
import { type Extraction, HttpResponseKind, SourceDescriptor } from 'http-extraction-fundamentals'
import { Review } from 'importer-fundamentals'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { LOCAL_SOURCE, type PickedHar } from '../sources/picked-har.ts'
import { NOTHING_TO_IMPORT_HEADING, PREVIEW_HEADING, PreviewPanel } from './preview-panel.tsx'
import { previewsFor } from './previews-for.ts'
import type { FileReadOutcome } from './use-import-run.ts'

/**
 * The preview panel composes the format's interactive `ReviewBody` per file
 * and gates one confirm over the whole batch. Driven directly — props in, DOM
 * out, over a synthetic source — the point under test is that every file
 * renders distinctly (a review, an unreadable notice), that the confirm names
 * the batch's included-resource total (not the response total), and that the
 * previewed resources drive both the counts and the write set.
 */

afterEach(cleanup)

/** A kind that claims URLs containing `token`, parsing to a fixed FHIR-ish resource. */
const kind = (
  name: string,
  token: string,
  resources: readonly unknown[] = [{ resourceType: 'Patient', id: `${name}-1` }]
): HttpResponseKind.HttpResponseKind<unknown> =>
  HttpResponseKind.make({
    name,
    tryRecognize: (url) => (url.includes(token) ? Option.some({ specificity: 50 }) : Option.none()),
    parse: () => Effect.succeed([...resources]),
  })

const pool = [
  kind('patient', '/Patient', [{ resourceType: 'Patient', id: 'pat-1' }]),
  kind('observation', '/Observation', [{ resourceType: 'Observation', id: 'obs-1' }]),
]

/** One synthetic source grouping the pool's kinds — the shape the panel now takes. */
const sources: readonly SourceDescriptor.SourceDescriptor<unknown>[] = [
  SourceDescriptor.make({
    name: 'ehr-source',
    display: { title: 'EHR source', description: 'Synthetic FHIR source for the panel test.' },
    responseKinds: pool,
  }),
]

/** One decoded response the recognizer reads. */
const input = (id: string, url: string): Extraction.Input => ({
  id,
  url,
  status: 200,
  statusText: 'OK',
  headers: [],
  startedAt: DateTime.unsafeNow(),
  body: new Uint8Array(),
  bodyAbsent: false,
})

describe('PreviewPanel', () => {
  it('renders a batch with nothing recognized as the nothing-to-import state', () => {
    const files = [readFile([input('r0', 'https://cdn.test/app.js')])]
    render(<PreviewPanel files={files} {...panelProps(files)} />)

    // Nothing recognized, so the top heading says so and there is no confirm.
    expect(screen.getByRole('heading', { name: NOTHING_TO_IMPORT_HEADING })).toBeDefined()
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined()
    // The unrecognized response folds into the no-match section.
    expect(screen.getByText(/1 response matched no importer/)).toBeDefined()
  })

  it('renders a review and a confirm naming the included-resource total', async () => {
    const onConfirm = vi.fn()
    const files = [
      readFile([
        input('r0', 'https://ehr.test/Patient/1'),
        input('r1', 'https://ehr.test/Observation?subject=1'),
      ]),
    ]
    render(<PreviewPanel files={files} {...panelProps(files, { onConfirm })} />)

    // The healthy heading and both recognized URLs are shown by the review.
    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    expect(screen.getByText('https://ehr.test/Patient/1')).toBeDefined()
    expect(screen.getByText('https://ehr.test/Observation?subject=1')).toBeDefined()

    // Two included resources ⇒ the confirm names two, and opting in calls back.
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 resources' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('sums a mixed batch: one confirm for the recognized files, each file rendered', () => {
    const files = [
      readFile([input('a0', 'https://ehr.test/Patient/1')], 'a.har'),
      readFile([input('b0', 'https://cdn.test/app.js')], 'b.har'),
      readFile([input('c0', 'https://ehr.test/Observation?s=1')], 'c.har'),
    ]
    render(<PreviewPanel files={files} {...panelProps(files)} />)

    // Two recognized resources across three files, one confirm; every file shows.
    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    expect(screen.getByText(/2 resources across 3 files/)).toBeDefined()
    expect(screen.getByRole('region', { name: 'a.har' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'b.har' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'c.har' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Import 2 resources' })).toBeDefined()
  })

  it('reports an unreadable file against its name without sinking a recognized sibling', () => {
    const files: readonly FileReadOutcome[] = [
      { _tag: 'unreadable', id: 'u', picked: pickedHar('broken.har'), error: anyParseError() },
      readFile([input('g0', 'https://ehr.test/Patient/1')], 'good.har'),
    ]
    render(<PreviewPanel files={files} {...panelProps(files)} />)

    expect(screen.getByText(/could not be read as a HAR/)).toBeDefined()
    // The recognized sibling still offers its confirm.
    expect(screen.getByRole('button', { name: 'Import 1 resource' })).toBeDefined()
  })

  it('disables the confirm while a confirmed import is running', () => {
    const files = [readFile([input('r0', 'https://ehr.test/Patient/1')])]
    render(<PreviewPanel files={files} {...panelProps(files, { confirming: true })} />)

    const confirm = screen.getByRole('button', { name: /Importing…/ })
    expect(confirm.getAttribute('disabled')).not.toBeNull()
  })
})

// Helpers

/** A `local` pick with the given name — the shape a read file carries. */
const pickedHar = (fileName: string): PickedHar => ({
  fileName,
  text: '{}',
  source: LOCAL_SOURCE,
})

/** A `read` {@link FileReadOutcome} wrapping some responses, named for the batch's file rows. */
const readFile = (
  responses: readonly Extraction.Input[],
  fileName = 'session.har'
): FileReadOutcome => ({
  _tag: 'read',
  id: fileName,
  picked: pickedHar(fileName),
  responses,
})

/** The shared panel props, with the sources + review wired and the previews computed. */
const panelProps = (
  files: readonly FileReadOutcome[],
  overrides: {
    readonly onConfirm?: () => void
    readonly confirming?: boolean
  } = {}
): {
  readonly sources: typeof sources
  readonly ReviewBody: typeof ReviewBody
  readonly selectionFor: () => Review.Selection
  readonly onSelectionChange: () => void
  readonly previewFor: (
    fileId: string
  ) => readonly Review.PreviewedResponse<HttpResponseKind.HttpResponseKind<unknown>, unknown>[]
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly confirming: boolean
} => {
  const selectionFor = (): Review.Selection => Review.initial(pool)
  const previews = previewsFor(sources, files, selectionFor)
  return {
    sources,
    ReviewBody,
    selectionFor,
    onSelectionChange: () => undefined,
    previewFor: (fileId) => previews.get(fileId) ?? [],
    onConfirm: overrides.onConfirm ?? (() => undefined),
    onCancel: () => undefined,
    confirming: overrides.confirming ?? false,
  }
}

/** A genuine `ParseError`, produced by a decode that must fail. */
const anyParseError = (): ParseResult.ParseError => {
  const result = Schema.decodeUnknownEither(Schema.Number)('not a number')
  if (Either.isRight(result)) throw new Error('unreachable: decode of a non-number succeeded')
  return result.left
}
