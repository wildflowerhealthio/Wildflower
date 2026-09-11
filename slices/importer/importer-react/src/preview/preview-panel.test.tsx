import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Either, type ParseResult, Schema } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import type { LabeledResource } from 'importer-fundamentals'
import { Review } from 'importer-fundamentals'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { FormatKind } from '../registry.tsx'
import { LOCAL_SOURCE, type PickedFile } from '../sources/picked-file.ts'
import {
  NOTHING_TO_IMPORT_HEADING,
  PREVIEW_HEADING,
  PreviewPanel,
  type PreviewPanelProps,
  type ReviewBodyRegistry,
  UNREADABLE_FILE_MESSAGE,
  UNRECOGNIZED_FILE_MESSAGE,
} from './preview-panel.tsx'
import type { FileReadOutcome } from './use-import-run.ts'

/**
 * The preview panel renders every picked file's review under one confirm.
 * Driven directly — props in, DOM out — the point under test is that every
 * file renders distinctly (a default resource list, an unreadable notice, an
 * unrecognized-file notice), that the confirm names the batch's
 * included-resource total, and that a null `ReviewBody` falls back to the
 * default per-resource checkbox list.
 */

afterEach(cleanup)

describe('PreviewPanel', () => {
  it('renders nothing-to-import when no files have labeled resources', () => {
    const files = [readFile('empty.har')]
    render(<PreviewPanel {...panelProps(files)} />)

    expect(screen.getByRole('heading', { name: NOTHING_TO_IMPORT_HEADING })).toBeDefined()
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined()
  })

  it('renders a preview heading and a confirm naming the included-resource total', async () => {
    const onConfirm = vi.fn()
    const files = [readFile('session.har')]
    const labeled = {
      'session.har': [
        labeledResource('pat-1', 'Patient/pat-1'),
        labeledResource('obs-1', 'Observation/obs-1'),
      ],
    }
    render(<PreviewPanel {...panelProps(files, { labeled, onConfirm })} />)

    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 resources' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('sums a mixed batch with an unreadable and an unrecognized file, each file rendered under its name', () => {
    const files: readonly FileReadOutcome[] = [
      readFile('a.har'),
      {
        _tag: 'unreadable',
        id: 'u',
        picked: pickedFile('broken.har'),
        format: 'har',
        error: anyParseError(),
      },
      { _tag: 'unrecognized', id: 'x', picked: pickedFile('notes.txt') },
      readFile('c.har'),
    ]
    const labeled = {
      'a.har': [labeledResource('pat-1', 'Patient/pat-1')],
      'c.har': [labeledResource('obs-1', 'Observation/obs-1')],
    }
    render(<PreviewPanel {...panelProps(files, { labeled })} />)

    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    expect(screen.getByText(/2 resources across 4 files/)).toBeDefined()
    expect(screen.getByRole('region', { name: 'a.har' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'broken.har' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'notes.txt' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'c.har' })).toBeDefined()
    expect(screen.getByText(UNREADABLE_FILE_MESSAGE)).toBeDefined()
    expect(screen.getByText(UNRECOGNIZED_FILE_MESSAGE)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Import 2 resources' })).toBeDefined()
  })

  it('disables the confirm while a confirmed import is running', () => {
    const files = [readFile('session.har')]
    const labeled = {
      'session.har': [labeledResource('pat-1', 'Patient/pat-1')],
    }
    render(<PreviewPanel {...panelProps(files, { labeled, confirming: true })} />)

    const confirm = screen.getByRole('button', { name: /Importing…/ })
    expect(confirm.getAttribute('disabled')).not.toBeNull()
  })

  it('renders a default resource list with include checkboxes when ReviewBody is null', () => {
    const files = [readFile('session.har')]
    const labeled = {
      'session.har': [
        labeledResource('pat-1', 'Patient/pat-1'),
        labeledResource('obs-1', 'Observation/obs-1'),
      ],
    }
    render(<PreviewPanel {...panelProps(files, { labeled })} />)

    // Each resource gets a checkbox with an aria-label naming the resource.
    expect(screen.getByRole('checkbox', { name: 'Include Patient/pat-1' })).toBeDefined()
    expect(screen.getByRole('checkbox', { name: 'Include Observation/obs-1' })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A `local` pick with the given name. */
const pickedFile = (fileName: string): PickedFile => ({
  fileName,
  bytes: new TextEncoder().encode('{}'),
  source: LOCAL_SOURCE,
})

/** A `read` {@link FileReadOutcome} with an opaque review — labels come from the prop. */
const readFile = (fileName = 'session.har', format: FormatKind = 'har'): FileReadOutcome => ({
  _tag: 'read',
  id: fileName,
  picked: pickedFile(fileName),
  format,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture: null-ish review, the panel never reads through it in a null-ReviewBody test
  review: {} as never,
})

/** A synthetic labeled resource for the panel to count and display. */
const labeledResource = (key: string, title: string): LabeledResource<FhirResource> => ({
  key,
  title,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture
  resource: { resourceType: 'Patient', id: key } as FhirResource,
})

/** Registry with every `ReviewBody` null — the default resource list path. */
const reviewBodyRegistry: ReviewBodyRegistry = {
  har: { ReviewBody: null },
  'lifelabs-pdf': { ReviewBody: null },
}

/** Shared panel props wired to synthetic lookups; every `ReviewBody` is `null` throughout. */
const panelProps = (
  files: readonly FileReadOutcome[],
  overrides: {
    readonly labeled?: Record<string, readonly LabeledResource<FhirResource>[]>
    readonly onConfirm?: () => void
    readonly confirming?: boolean
  } = {}
): PreviewPanelProps => {
  const labeledMap = overrides.labeled ?? {}
  return {
    files,
    reviewBodyRegistry,
    reviewFor: (file) => file,
    labeledFor: (fileId) => labeledMap[fileId] ?? [],
    selectionFor: () => Review.initial<FhirResource>(),
    onReviewChange: () => undefined,
    onSelectionChange: () => undefined,
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
