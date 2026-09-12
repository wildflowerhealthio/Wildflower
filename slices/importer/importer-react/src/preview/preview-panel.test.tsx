import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Either, type ParseResult, Schema } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import type { DecodedFile, LabeledResource, LabeledSection } from 'importer-fundamentals'
import { Review } from 'importer-fundamentals'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { defaultFormatSettings, type FormatKind, type FormatSettings } from '../registry.ts'
import { LOCAL_SOURCE, type PickedFile } from '../sources/picked-file.ts'
import {
  NO_RESOURCES_MESSAGE,
  NOTHING_TO_IMPORT_HEADING,
  PREVIEW_HEADING,
  PreviewPanel,
  type PreviewPanelProps,
  type SettingsRegistry,
  UNREADABLE_FILE_MESSAGE,
  UNRECOGNIZED_FILE_MESSAGE,
} from './preview-panel.tsx'
import type { FileReadOutcome } from './use-import-run.ts'

/**
 * The preview panel renders every picked file's review under one confirm.
 * Driven directly — props in, DOM out — the point under test is the
 * generalized display: files grouped by format under that format's settings
 * form, each read file's decoded sections rendered with per-resource include
 * checkboxes, notes folded into a details block, and the confirm naming the
 * batch's included-resource total.
 */

afterEach(cleanup)

describe('PreviewPanel', () => {
  it('renders nothing-to-import when no file decoded any resource', () => {
    const files = [readFile('empty.har', decoded([]))]
    render(<PreviewPanel {...panelProps(files)} />)

    expect(screen.getByRole('heading', { name: NOTHING_TO_IMPORT_HEADING })).toBeDefined()
    expect(screen.getByText(NO_RESOURCES_MESSAGE)).toBeDefined()
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined()
  })

  it('renders a preview heading and a confirm naming the included-resource total', async () => {
    const onConfirm = vi.fn()
    const files = [
      readFile(
        'session.har',
        decoded([
          section('https://r4.example.org/Patient/pat-1', [
            labeledResource('pat-1', 'Patient/pat-1'),
            labeledResource('obs-1', 'Observation/obs-1'),
          ]),
        ])
      ),
    ]
    render(<PreviewPanel {...panelProps(files, { onConfirm })} />)

    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 resources' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('renders each decoded section under its own title with per-resource include checkboxes', () => {
    const files = [
      readFile(
        'reports.pdf',
        decoded([
          section('Lab No 2024-JJ1 — Aug 13 2026 13:02', [labeledResource('p1', 'Patient/p1')]),
          section('Lab No 2024-JJ2 — Aug 20 2026 09:15', [labeledResource('o1', 'Observation/o1')]),
        ]),
        'lifelabs-pdf'
      ),
    ]
    render(<PreviewPanel {...panelProps(files)} />)

    expect(
      screen.getByRole('heading', { name: 'Lab No 2024-JJ1 — Aug 13 2026 13:02' })
    ).toBeDefined()
    expect(
      screen.getByRole('heading', { name: 'Lab No 2024-JJ2 — Aug 20 2026 09:15' })
    ).toBeDefined()
    expect(screen.getByRole('checkbox', { name: /Include Patient/ })).toBeDefined()
    expect(screen.getByRole('checkbox', { name: /Include Observation/ })).toBeDefined()
  })

  it('sums a mixed batch with an unreadable and an unrecognized file, each file rendered under its name', () => {
    const files: readonly FileReadOutcome[] = [
      readFile(
        'a.har',
        decoded([section('https://a', [labeledResource('pat-1', 'Patient/pat-1')])])
      ),
      {
        _tag: 'unreadable',
        id: 'u',
        picked: pickedFile('broken.har'),
        format: 'har',
        error: anyParseError(),
      },
      { _tag: 'unrecognized', id: 'x', picked: pickedFile('notes.txt') },
      readFile(
        'c.har',
        decoded([section('https://c', [labeledResource('obs-1', 'Observation/obs-1')])])
      ),
    ]
    render(<PreviewPanel {...panelProps(files)} />)

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

  it('folds a read file’s notes into a collapsed details block', () => {
    const files = [
      readFile(
        'session.har',
        decoded(
          [section('https://a', [labeledResource('pat-1', 'Patient/pat-1')])],
          [
            'Matched no importer: https://example.org/tracker.js',
            'The archive captured no response body: https://a/empty',
          ]
        )
      ),
    ]
    render(<PreviewPanel {...panelProps(files)} />)

    expect(screen.getByText('2 notes')).toBeDefined()
    expect(screen.getByText('Matched no importer: https://example.org/tracker.js')).toBeDefined()
  })

  it('mounts one settings form per format present and reports a change against its format', async () => {
    const onSettingsChange = vi.fn()
    const files = [
      readFile('a.har', decoded([section('https://a', [labeledResource('p', 'Patient/p')])])),
      readFile(
        'r.pdf',
        decoded([section('Lab No 1', [labeledResource('o', 'Observation/o')])]),
        'lifelabs-pdf'
      ),
    ]
    render(<PreviewPanel {...panelProps(files, { onSettingsChange })} />)

    // One group per format, titled by the format's display title.
    expect(screen.getByRole('region', { name: 'HAR archive' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'LifeLabs report' })).toBeDefined()

    await userEvent.click(screen.getByRole('button', { name: 'change har settings' }))
    expect(onSettingsChange).toHaveBeenCalledWith('har', defaultFormatSettings.har)
  })

  it('disables the confirm while a confirmed import is running', () => {
    const files = [
      readFile(
        'session.har',
        decoded([section('https://a', [labeledResource('pat-1', 'Patient/pat-1')])])
      ),
    ]
    render(<PreviewPanel {...panelProps(files, { confirming: true })} />)

    const confirm = screen.getByRole('button', { name: /Importing…/ })
    expect(confirm.getAttribute('disabled')).not.toBeNull()
  })

  it('reports a toggled-off resource through onSelectionChange and drops it from the confirm count', async () => {
    const onSelectionChange = vi.fn()
    const files = [
      readFile(
        'session.har',
        decoded([
          section('https://a', [
            labeledResource('pat-1', 'Patient/pat-1'),
            labeledResource('obs-1', 'Observation/obs-1'),
          ]),
        ])
      ),
    ]
    render(<PreviewPanel {...panelProps(files, { onSelectionChange })} />)

    await userEvent.click(screen.getByRole('checkbox', { name: /Include Patient/ }))

    expect(onSelectionChange).toHaveBeenCalledWith(
      'session.har',
      Review.toggleResource(Review.initial<FhirResource>(), 'pat-1')
    )
  })

  it('opts a whole section out in one click when every resource was included', async () => {
    const onSelectionChange = vi.fn()
    const files = [
      readFile(
        'reports.pdf',
        decoded([
          section('Lab No 2024-JJ1', [
            labeledResource('p1', 'Patient/p1'),
            labeledResource('o1', 'Observation/o1'),
          ]),
        ]),
        'lifelabs-pdf'
      ),
    ]
    render(<PreviewPanel {...panelProps(files, { onSelectionChange })} />)

    await userEvent.click(screen.getByRole('checkbox', { name: 'Include all in Lab No 2024-JJ1' }))

    expect(onSelectionChange).toHaveBeenCalledWith(
      'reports.pdf',
      Review.setResourcesIncluded(Review.initial<FhirResource>(), ['p1', 'o1'], false)
    )
  })

  it('opts a partially-included section fully in, and shows the toggle indeterminate', async () => {
    const onSelectionChange = vi.fn()
    // One of the two resources is already excluded — the section toggle reads
    // indeterminate, and clicking it includes the whole section.
    const partial = Review.toggleResource(Review.initial<FhirResource>(), 'o1')
    const files = [
      readFile(
        'reports.pdf',
        decoded([
          section('Lab No 2024-JJ1', [
            labeledResource('p1', 'Patient/p1'),
            labeledResource('o1', 'Observation/o1'),
          ]),
        ]),
        'lifelabs-pdf'
      ),
    ]
    render(
      <PreviewPanel {...panelProps(files, { onSelectionChange, selectionFor: () => partial })} />
    )

    const toggle = screen.getByRole('checkbox', { name: 'Include all in Lab No 2024-JJ1' })
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the query returns the section-toggle input element
    expect((toggle as HTMLInputElement).indeterminate).toBe(true)

    await userEvent.click(toggle)

    expect(onSelectionChange).toHaveBeenCalledWith(
      'reports.pdf',
      Review.setResourcesIncluded(partial, ['p1', 'o1'], true)
    )
  })
})

// Helpers

/** A `local` pick with the given name. */
const pickedFile = (fileName: string): PickedFile => ({
  fileName,
  bytes: new TextEncoder().encode('{}'),
  source: LOCAL_SOURCE,
})

/** A `read` {@link FileReadOutcome} carrying the given decoded sections. */
const readFile = (
  fileName: string,
  decodedFile: DecodedFile<FhirResource>,
  format: FormatKind = 'har'
): FileReadOutcome => ({
  _tag: 'read',
  id: fileName,
  picked: pickedFile(fileName),
  format,
  decoded: decodedFile,
})

/** A decoded file from sections and optional notes. */
const decoded = (
  sections: readonly LabeledSection<FhirResource>[],
  notes: readonly string[] = []
): DecodedFile<FhirResource> => ({ sections, notes })

/** One titled section holding the given resources. */
const section = (
  title: string,
  resources: readonly LabeledResource<FhirResource>[]
): LabeledSection<FhirResource> => ({ title, resources })

/** A synthetic labeled resource for the panel to count and display. */
const labeledResource = (key: string, title: string): LabeledResource<FhirResource> => {
  const [resourceType = 'Patient', id = key] = title.split('/')
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture: the panel only reads resourceType/id off the resource
  const resource = { resourceType, id } as FhirResource
  return { key, title, resource }
}

/** A settings registry whose pickers are one-button stubs reporting the default settings back. */
const settingsRegistry: SettingsRegistry = {
  har: {
    display: { title: 'HAR archive', description: 'HAR' },
    SettingsPicker: ({ onChange }): JSX.Element => (
      <button type="button" onClick={() => onChange(defaultFormatSettings.har)}>
        change har settings
      </button>
    ),
  },
  'lifelabs-pdf': {
    display: { title: 'LifeLabs report', description: 'LifeLabs' },
    SettingsPicker: ({ onChange }): JSX.Element => (
      <button type="button" onClick={() => onChange(defaultFormatSettings['lifelabs-pdf'])}>
        change lifelabs settings
      </button>
    ),
  },
}

/** Shared panel props wired to synthetic lookups. */
const panelProps = (
  files: readonly FileReadOutcome[],
  overrides: {
    readonly onConfirm?: () => void
    readonly onSelectionChange?: PreviewPanelProps['onSelectionChange']
    readonly onSettingsChange?: PreviewPanelProps['onSettingsChange']
    readonly selectionFor?: PreviewPanelProps['selectionFor']
    readonly confirming?: boolean
  } = {}
): PreviewPanelProps => {
  const settings: FormatSettings = defaultFormatSettings
  return {
    files,
    settings,
    settingsRegistry,
    selectionFor: overrides.selectionFor ?? (() => Review.initial<FhirResource>()),
    diffStatuses: new Map(),
    onSelectionChange: overrides.onSelectionChange ?? (() => undefined),
    onSettingsChange: overrides.onSettingsChange ?? (() => undefined),
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
