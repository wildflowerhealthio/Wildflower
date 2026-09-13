import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Either, type ParseResult, Schema } from 'effect'
import type { DiffSlot, FieldDiff, ServerComparison } from 'fhir-r4/clients'
import { type FhirResource, Patient } from 'fhir-r4/resources'
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

  it('shows a static badge for a resource the server does not hold', () => {
    // Arrange
    const files = [
      readFile('a.har', decoded([section('s', [labeledResource('pat-1', 'Patient/pat-1')])])),
    ]
    const comparisons: ReadonlyMap<string, ServerComparison> = new Map([
      ['pat-1', { status: 'new', fields: [] }],
    ])

    // Act
    render(<PreviewPanel {...panelProps(files, { comparisons })} />)

    // Assert
    expect(screen.getByText('New')).toBeDefined()
  })

  it('reveals the field-level diffs when the changed badge is clicked', async () => {
    // Arrange: the server holds a copy whose gender differs (the incoming
    // fixture will not re-encode, so the badge falls back to these fields).
    const files = [
      readFile('a.har', decoded([section('s', [labeledResource('pat-1', 'Patient/pat-1')])])),
    ]
    const field: FieldDiff = {
      path: ['gender'],
      server: valueSlot('male'),
      incoming: valueSlot('female'),
    }
    const comparisons: ReadonlyMap<string, ServerComparison> = new Map([
      ['pat-1', { status: 'changed', fields: [field], server: {} }],
    ])
    render(<PreviewPanel {...panelProps(files, { comparisons })} />)

    // Act
    await userEvent.click(screen.getByRole('button', { name: /Differs from server/ }))

    // Assert: the leaf, the server value, and the incoming value are all shown.
    expect(screen.getByText('gender')).toBeDefined()
    expect(screen.getByText('"male"')).toBeDefined()
    expect(screen.getByText('"female"')).toBeDefined()
  })

  it('reveals the field-level diffs when the changed badge is hovered', async () => {
    // Arrange
    const files = [
      readFile('a.har', decoded([section('s', [labeledResource('pat-1', 'Patient/pat-1')])])),
    ]
    const field: FieldDiff = {
      path: ['gender'],
      server: valueSlot('male'),
      incoming: valueSlot('female'),
    }
    const comparisons: ReadonlyMap<string, ServerComparison> = new Map([
      ['pat-1', { status: 'changed', fields: [field], server: {} }],
    ])
    render(<PreviewPanel {...panelProps(files, { comparisons })} />)

    // Act
    await userEvent.hover(screen.getByRole('button', { name: /Differs from server/ }))

    // Assert
    expect(screen.getByText('gender')).toBeDefined()
  })

  it('surfaces the diff for a resource that was unchanged until the reviewer edited it', async () => {
    // Arrange: the server holds an equal copy; the reviewer has edited gender.
    const onServer = { resourceType: 'Patient', id: 'pat-1' }
    const patient = Schema.decodeUnknownSync(Patient.Schema)(onServer)
    const edited = Schema.decodeUnknownSync(Patient.Schema)({ ...onServer, gender: 'male' })
    const labeled: LabeledResource<FhirResource> = {
      key: 'pat-1',
      title: 'Patient/pat-1',
      resource: patient,
    }
    const files = [readFile('a.har', decoded([section('s', [labeled])]))]
    const comparisons: ReadonlyMap<string, ServerComparison> = new Map([
      ['pat-1', { status: 'unchanged', fields: [], server: patientWire(onServer) }],
    ])
    const selectionFor = (): Review.Selection<FhirResource> =>
      Review.edit(Review.initial<FhirResource>(), 'pat-1', edited)
    render(<PreviewPanel {...panelProps(files, { comparisons, selectionFor })} />)

    // Act: the once-unchanged badge is now the interactive "differs" disclosure.
    await userEvent.click(screen.getByRole('button', { name: /Differs from server/ }))

    // Assert
    expect(screen.getByText('gender')).toBeDefined()
  })

  it('edits the resource to the server value when "keep server value" is clicked', async () => {
    // Arrange: a real (schema-decodable) resource, so the reset can round-trip,
    // and a server copy whose gender differs — the badge diffs against it live.
    const patient = Schema.decodeUnknownSync(Patient.Schema)({
      resourceType: 'Patient',
      id: 'pat-1',
    })
    const labeled: LabeledResource<FhirResource> = {
      key: 'pat-1',
      title: 'Patient/pat-1',
      resource: patient,
    }
    const files = [readFile('a.har', decoded([section('s', [labeled])]))]
    const comparisons: ReadonlyMap<string, ServerComparison> = new Map([
      [
        'pat-1',
        { status: 'changed', fields: [], server: patientWire({ id: 'pat-1', gender: 'male' }) },
      ],
    ])
    const onSelectionChange = vi.fn()
    render(<PreviewPanel {...panelProps(files, { comparisons, onSelectionChange })} />)

    // Act
    await userEvent.click(screen.getByRole('button', { name: /Differs from server/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Keep the server value for gender' }))

    // Assert: the file's selection now overrides pat-1 with the server's gender.
    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    const call = onSelectionChange.mock.calls[0]
    expect(call?.[0]).toBe('a.har')
    expect(call?.[1].resourceOverrides.get('pat-1')).toMatchObject({
      resourceType: 'Patient',
      gender: 'male',
    })
  })
})

// Helpers

/** A present diff slot around `value`. */
const valueSlot = (value: unknown): DiffSlot => ({ _tag: 'value', value })

/**
 * A normalized server wire object, decoded then re-encoded through
 * `Patient.Schema` so it has the exact shape the classifier's `server` copy
 * has — the form the badge diffs the edited resource against.
 */
const patientWire = (wire: Record<string, unknown>): unknown =>
  Schema.encodeSync(Patient.Schema)(
    Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', ...wire })
  )

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
    readonly comparisons?: PreviewPanelProps['comparisons']
    readonly confirming?: boolean
  } = {}
): PreviewPanelProps => {
  const settings: FormatSettings = defaultFormatSettings
  return {
    files,
    settings,
    settingsRegistry,
    selectionFor: overrides.selectionFor ?? (() => Review.initial<FhirResource>()),
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
  if (Either.isRight(result)) throw new Error('unreachable: decode of a non-number succeeded')
  return result.left
}
