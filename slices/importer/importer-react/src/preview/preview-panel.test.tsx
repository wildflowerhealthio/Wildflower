import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Schema, type ParseResult } from 'effect'
import type { DiffSlot, FieldDiff, ServerComparison } from 'fhir-r4/clients'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import {
  type BatchDecodeResult,
  type FormatKind,
  type FormatSettings,
  type UnrecognizedFile,
} from 'importer-core'
import { StagedImport, FormatDecode, type DecodedFile, PickedFile } from 'importer-fundamentals'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { defaultFormatSettings } from '../registry.ts'
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

/**
 * The preview panel renders every format's review under one confirm.
 * Driven directly — props in, DOM out — the point under test is the
 * generalized display: formats grouped under that format's settings
 * form, each format's decoded sections rendered with per-resource include
 * checkboxes, notes folded into a details block, and the confirm naming the
 * batch's included-resource total.
 */

afterEach(cleanup)

describe('PreviewPanel', () => {
  it('renders nothing-to-import when no format decoded any resource', () => {
    const batch = makeBatch({ har: formatResult('empty.har', decoded([]), 'har') })
    render(<PreviewPanel {...panelProps(batch)} />)

    expect(screen.getByRole('heading', { name: NOTHING_TO_IMPORT_HEADING })).toBeDefined()
    expect(screen.getByText(NO_RESOURCES_MESSAGE)).toBeDefined()
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined()
  })

  it('renders a preview heading and a confirm naming the included-resource total', async () => {
    const onConfirm = vi.fn()
    const batch = makeBatch({
      har: formatResult(
        'session.har',
        decoded([
          section('https://r4.example.org/Patient/pat-1', [
            labeledResource('pat-1', 'Patient/pat-1'),
            labeledResource('obs-1', 'Observation/obs-1'),
          ]),
        ]),
        'har'
      ),
    })
    render(<PreviewPanel {...panelProps(batch, { onConfirm })} />)

    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 resources' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('renders each decoded section under its own title with per-resource include checkboxes', () => {
    const batch = makeBatch({
      'lifelabs-pdf': formatResult(
        'reports.pdf',
        decoded([
          section('Lab No 2024-JJ1 — Aug 13 2026 13:02', [labeledResource('p1', 'Patient/p1')]),
          section('Lab No 2024-JJ2 — Aug 20 2026 09:15', [labeledResource('o1', 'Observation/o1')]),
        ]),
        'lifelabs-pdf'
      ),
    })
    render(<PreviewPanel {...panelProps(batch)} />)

    expect(
      screen.getByRole('heading', { name: 'Lab No 2024-JJ1 — Aug 13 2026 13:02' })
    ).toBeDefined()
    expect(
      screen.getByRole('heading', { name: 'Lab No 2024-JJ2 — Aug 20 2026 09:15' })
    ).toBeDefined()
    expect(screen.getByRole('checkbox', { name: /Include Patient/ })).toBeDefined()
    expect(screen.getByRole('checkbox', { name: /Include Observation/ })).toBeDefined()
  })

  it('sums a mixed batch with unreadable and unrecognized files', () => {
    const batch: BatchDecodeResult = {
      har: {
        id: 'har/a.har,broken.har,c.har',
        title: 'a.har, broken.har, c.har',
        files: [pickedFile('a.har'), pickedFile('broken.har'), pickedFile('c.har')],
        format: 'har',
        decoded: decoded([
          section('https://a', [labeledResource('pat-1', 'Patient/pat-1')]),
          section('https://c', [labeledResource('obs-1', 'Observation/obs-1')]),
        ]),
        unreadableFiles: [
          {
            id: 'har/broken.har',
            title: 'broken.har',
            pickedFile: pickedFile('broken.har'),
            error: anyParseError(),
          },
        ],
      },
      'lifelabs-pdf': FormatDecode.emptyResult('lifelabs-pdf'),
      dicom: FormatDecode.emptyResult('dicom'),
      unrecognizedFiles: [
        {
          id: 'x',
          title: 'notes.txt',
          files: [pickedFile('notes.txt')],
        },
      ],
    }
    render(<PreviewPanel {...panelProps(batch)} />)

    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    // 3 har files + 1 unrecognized = 4 total
    expect(screen.getByText(/2 resources across 4 files/)).toBeDefined()
    expect(screen.getByRole('region', { name: 'HAR archive' })).toBeDefined()
    expect(screen.getByText(/broken\.har/)).toBeDefined()
    expect(screen.getByText(UNREADABLE_FILE_MESSAGE, { exact: false })).toBeDefined()
    expect(screen.getByRole('region', { name: 'notes.txt' })).toBeDefined()
    expect(screen.getByText(UNRECOGNIZED_FILE_MESSAGE)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Import 2 resources' })).toBeDefined()
  })

  it("folds a format's notes into a collapsed details block", () => {
    const batch = makeBatch({
      har: formatResult(
        'session.har',
        decoded(
          [section('https://a', [labeledResource('pat-1', 'Patient/pat-1')])],
          [
            'Matched no importer: https://example.org/tracker.js',
            'The archive captured no response body: https://a/empty',
          ]
        ),
        'har'
      ),
    })
    render(<PreviewPanel {...panelProps(batch)} />)

    expect(screen.getByText('2 notes')).toBeDefined()
    expect(screen.getByText('Matched no importer: https://example.org/tracker.js')).toBeDefined()
  })

  it('mounts one settings form per format present and reports a change against its format', async () => {
    const onSettingsChange = vi.fn()
    const batch = makeBatch({
      har: formatResult(
        'a.har',
        decoded([section('https://a', [labeledResource('p', 'Patient/p')])]),
        'har'
      ),
      'lifelabs-pdf': formatResult(
        'r.pdf',
        decoded([section('Lab No 1', [labeledResource('o', 'Observation/o')])]),
        'lifelabs-pdf'
      ),
    })
    render(<PreviewPanel {...panelProps(batch, { onSettingsChange })} />)

    // One group per format, titled by the format's display title.
    expect(screen.getByRole('region', { name: 'HAR archive' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'LifeLabs report' })).toBeDefined()

    await userEvent.click(screen.getByRole('button', { name: 'change har settings' }))
    expect(onSettingsChange).toHaveBeenCalledWith('har', defaultFormatSettings.har)
  })

  it("mounts each format's own settings picker, DICOM included", async () => {
    const onSettingsChange = vi.fn()
    const batch = makeBatch({
      dicom: formatResult(
        'scan.dcm',
        decoded([section('CT Chest', [labeledResource('s', 'Patient/s')])]),
        'dicom'
      ),
    })
    render(<PreviewPanel {...panelProps(batch, { onSettingsChange })} />)

    expect(screen.getByRole('region', { name: 'DICOM image' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'change lifelabs settings' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'change dicom settings' }))
    expect(onSettingsChange).toHaveBeenCalledWith('dicom', defaultFormatSettings.dicom)
  })

  it('disables the confirm while a confirmed import is running', () => {
    const batch = makeBatch({
      har: formatResult(
        'session.har',
        decoded([section('https://a', [labeledResource('pat-1', 'Patient/pat-1')])]),
        'har'
      ),
    })
    render(<PreviewPanel {...panelProps(batch, { confirming: true })} />)

    const confirm = screen.getByRole('button', { name: /Importing…/ })
    expect(confirm.getAttribute('disabled')).not.toBeNull()
  })

  it('reports a toggled-off resource through onSelectionChange keyed by format kind', async () => {
    const onSelectionChange = vi.fn()
    const batch = makeBatch({
      har: formatResult(
        'session.har',
        decoded([
          section('https://a', [
            labeledResource('pat-1', 'Patient/pat-1'),
            labeledResource('obs-1', 'Observation/obs-1'),
          ]),
        ]),
        'har'
      ),
    })
    render(<PreviewPanel {...panelProps(batch, { onSelectionChange })} />)

    await userEvent.click(screen.getByRole('checkbox', { name: /Include Patient/ }))

    expect(onSelectionChange).toHaveBeenCalledWith(
      'har',
      StagedImport.toggleResource(StagedImport.initial(), 'pat-1')
    )
  })

  it('opts a whole section out in one click when every resource was included', async () => {
    const onSelectionChange = vi.fn()
    const batch = makeBatch({
      'lifelabs-pdf': formatResult(
        'reports.pdf',
        decoded([
          section('Lab No 2024-JJ1', [
            labeledResource('p1', 'Patient/p1'),
            labeledResource('o1', 'Observation/o1'),
          ]),
        ]),
        'lifelabs-pdf'
      ),
    })
    render(<PreviewPanel {...panelProps(batch, { onSelectionChange })} />)

    await userEvent.click(screen.getByRole('checkbox', { name: 'Include all in Lab No 2024-JJ1' }))

    expect(onSelectionChange).toHaveBeenCalledWith(
      'lifelabs-pdf',
      StagedImport.setResourcesIncluded(StagedImport.initial(), ['p1', 'o1'], false)
    )
  })

  it('opts a partially-included section fully in, and shows the toggle indeterminate', async () => {
    const onSelectionChange = vi.fn()
    const partial = StagedImport.toggleResource(StagedImport.initial(), 'o1')
    const batch = makeBatch({
      'lifelabs-pdf': formatResult(
        'reports.pdf',
        decoded([
          section('Lab No 2024-JJ1', [
            labeledResource('p1', 'Patient/p1'),
            labeledResource('o1', 'Observation/o1'),
          ]),
        ]),
        'lifelabs-pdf'
      ),
    })
    render(
      <PreviewPanel {...panelProps(batch, { onSelectionChange, selectionFor: () => partial })} />
    )

    const toggle = screen.getByRole('checkbox', { name: 'Include all in Lab No 2024-JJ1' })
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the query returns the section-toggle input element
    expect((toggle as HTMLInputElement).indeterminate).toBe(true)

    await userEvent.click(toggle)

    expect(onSelectionChange).toHaveBeenCalledWith(
      'lifelabs-pdf',
      StagedImport.setResourcesIncluded(partial, ['p1', 'o1'], true)
    )
  })

  it('shows a static badge for a resource the server does not hold', () => {
    const batch = makeBatch({
      har: formatResult(
        'a.har',
        decoded([section('s', [labeledResource('pat-1', 'Patient/pat-1')])]),
        'har'
      ),
    })
    const comparisons = comparisonsFor('har', [['pat-1', { status: 'new', fields: [] }]])

    render(<PreviewPanel {...panelProps(batch, { comparisons })} />)

    expect(screen.getByText('New')).toBeDefined()
  })

  it('reveals the field-level diffs when the changed badge is clicked', async () => {
    const batch = makeBatch({
      har: formatResult(
        'a.har',
        decoded([section('s', [labeledResource('pat-1', 'Patient/pat-1')])]),
        'har'
      ),
    })
    const field: FieldDiff = {
      path: ['gender'],
      server: valueSlot('male'),
      incoming: valueSlot('female'),
    }
    const comparisons = comparisonsFor('har', [
      ['pat-1', { status: 'changed', fields: [field], server: {} }],
    ])
    render(<PreviewPanel {...panelProps(batch, { comparisons })} />)

    await userEvent.click(screen.getByRole('button', { name: /Differs from server/ }))

    expect(screen.getByText('gender')).toBeDefined()
    expect(screen.getByText('"male"')).toBeDefined()
    expect(screen.getByText('"female"')).toBeDefined()
  })

  it('reveals the field-level diffs when the changed badge is hovered', async () => {
    const batch = makeBatch({
      har: formatResult(
        'a.har',
        decoded([section('s', [labeledResource('pat-1', 'Patient/pat-1')])]),
        'har'
      ),
    })
    const field: FieldDiff = {
      path: ['gender'],
      server: valueSlot('male'),
      incoming: valueSlot('female'),
    }
    const comparisons = comparisonsFor('har', [
      ['pat-1', { status: 'changed', fields: [field], server: {} }],
    ])
    render(<PreviewPanel {...panelProps(batch, { comparisons })} />)

    await userEvent.hover(screen.getByRole('button', { name: /Differs from server/ }))

    expect(screen.getByText('gender')).toBeDefined()
  })

  it('surfaces the diff for a resource that was unchanged until the reviewer edited it', async () => {
    const onServer = { resourceType: 'Patient', id: 'pat-1' }
    const patientResource = Schema.decodeUnknownSync(Patient.Schema)(onServer)
    const edited = Schema.decodeUnknownSync(Patient.Schema)({ ...onServer, gender: 'male' })
    const labeled: DecodedFile.Resource = {
      key: 'pat-1',
      title: 'Patient/pat-1',
      resource: patientResource,
    }
    const batch = makeBatch({
      har: formatResult('a.har', decoded([section('s', [labeled])]), 'har'),
    })
    const comparisons = comparisonsFor('har', [
      ['pat-1', { status: 'unchanged', fields: [], server: patientWire(onServer) }],
    ])
    const selectionFor = (): StagedImport.Selection =>
      StagedImport.edit(StagedImport.initial(), 'pat-1', edited)
    render(<PreviewPanel {...panelProps(batch, { comparisons, selectionFor })} />)

    await userEvent.click(screen.getByRole('button', { name: /Differs from server/ }))

    expect(screen.getByText('gender')).toBeDefined()
  })

  it('edits the resource to the server value when "keep server value" is clicked', async () => {
    const patientResource = Schema.decodeUnknownSync(Patient.Schema)({
      resourceType: 'Patient',
      id: 'pat-1',
    })
    const labeled: DecodedFile.Resource = {
      key: 'pat-1',
      title: 'Patient/pat-1',
      resource: patientResource,
    }
    const batch = makeBatch({
      har: formatResult('a.har', decoded([section('s', [labeled])]), 'har'),
    })
    const comparisons = comparisonsFor('har', [
      [
        'pat-1',
        { status: 'changed', fields: [], server: patientWire({ id: 'pat-1', gender: 'male' }) },
      ],
    ])
    const onSelectionChange = vi.fn()
    render(<PreviewPanel {...panelProps(batch, { comparisons, onSelectionChange })} />)

    await userEvent.click(screen.getByRole('button', { name: /Differs from server/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Keep the server value for gender' }))

    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    const call = onSelectionChange.mock.calls[0]
    expect(call?.[0]).toBe('har')
    expect(call?.[1].resourceOverrides.get('pat-1')).toMatchObject({
      resourceType: 'Patient',
      gender: 'male',
    })
  })
})

// Helpers

/** A present diff slot around `value`. */
const valueSlot = (value: unknown): DiffSlot => ({ _tag: 'value', value })

const patientWire = (wire: Record<string, unknown>): unknown =>
  Schema.encodeSync(Patient.Schema)(
    Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', ...wire })
  )

/** A `local` pick with the given name. */
const pickedFile = (fileName: string): PickedFile.Type => ({
  fileName,
  bytes: new TextEncoder().encode('{}'),
  source: PickedFile.Source.local,
})

/**
 * A `FormatDecodeResult` carrying the given decoded sections, titled by its file name.
 *
 * @typeParam K - The format this result belongs to; generic so the result
 *   stays correlated with the {@link makeBatch} slot it fills
 */
const formatResult = <K extends FormatKind>(
  fileName: string,
  decodedFile: DecodedFile.DecodedFile,
  format: K
): FormatDecode.Result<K> => ({
  id: `${format}/${fileName}`,
  title: fileName,
  files: [pickedFile(fileName)],
  format,
  decoded: decodedFile,
  unreadableFiles: [],
})

/** Build a BatchDecodeResult from partial format results. */
const makeBatch = (
  results: Partial<{ [K in FormatKind]: FormatDecode.Result<K> }>,
  unrecognizedFiles: readonly UnrecognizedFile[] = []
): BatchDecodeResult => ({
  har: FormatDecode.emptyResult('har'),
  'lifelabs-pdf': FormatDecode.emptyResult('lifelabs-pdf'),
  dicom: FormatDecode.emptyResult('dicom'),
  ...results,
  unrecognizedFiles,
})

/** Verdicts for a format, keyed by format kind. */
const comparisonsFor = (
  format: FormatKind,
  entries: readonly (readonly [string, ServerComparison])[]
): PreviewPanelProps['comparisons'] => new Map([[format, new Map(entries)]])

/** A decoded file from sections and optional notes. */
const decoded = (
  sections: readonly DecodedFile.Section[],
  notes: readonly string[] = []
): DecodedFile.DecodedFile => ({ sections, notes })

/** One titled section holding the given resources. */
const section = (
  title: string,
  resources: readonly DecodedFile.Resource[]
): DecodedFile.Section => ({ title, resources })

/** A synthetic labeled resource for the panel to count and display. */
const labeledResource = (key: string, title: string): DecodedFile.Resource => {
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
  dicom: {
    display: { title: 'DICOM image', description: 'DICOM' },
    SettingsPicker: ({ onChange }): JSX.Element => (
      <button type="button" onClick={() => onChange(defaultFormatSettings.dicom)}>
        change dicom settings
      </button>
    ),
  },
}

/** Shared panel props wired to synthetic lookups. */
const panelProps = (
  batch: BatchDecodeResult,
  overrides: {
    readonly onConfirm?: () => void
    readonly onSelectionChange?: PreviewPanelProps['onSelectionChange']
    readonly onSettingsChange?: PreviewPanelProps['onSettingsChange']
    readonly selectionFor?: PreviewPanelProps['selectionFor']
    readonly comparisons?: PreviewPanelProps['comparisons']
    readonly confirming?: boolean
  } = {}
): PreviewPanelProps => {
  const settings: FormatSettings = defaultFormatSettings
  return {
    batch,
    settings,
    settingsRegistry,
    selectionFor: overrides.selectionFor ?? (() => StagedImport.initial()),
    comparisons: overrides.comparisons ?? new Map(),
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
  if ('right' in result) throw new Error('unreachable: decode of a non-number succeeded')
  return result.left
}
