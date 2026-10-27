import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { DiffSlot, FieldDiff, ServerComparison } from '@wildflowerhealthio/fhir-r4/clients'
import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResourceWithId,
  Observation,
  Patient,
  Practitioner,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  type FormatKind,
  type FormatSettings,
  type ResolvedBatch,
  type UnrecognizedFile,
} from '@wildflowerhealthio/importer-core'
import {
  StagedImport,
  FormatDecode,
  type DecodedFile,
  LinkableResource,
  LinkTarget,
  type PickedFile,
  type Referent,
} from '@wildflowerhealthio/importer-fundamentals'
import { Option, Schema, type ParseResult } from 'effect'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { defaultFormatSettings } from '@wildflowerhealthio/importer-core'
import { PreviewPanel, type PreviewPanelProps, type SettingsRegistry } from './preview-panel.tsx'
import {
  LINKED_RECORDS_HEADING,
  NO_RESOURCES_MESSAGE,
  NOTHING_TO_IMPORT_HEADING,
  PREVIEW_HEADING,
  UNREADABLE_FILE_MESSAGE,
  UNRECOGNIZED_FILE_MESSAGE,
} from './preview-text.ts'
import { LINKED_GROUP } from './use-server-diff.ts'

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
  it('lists the linked records read-only with their diff, and counts one a written resource names into the confirm', () => {
    const batch = withLinkedPatient(
      makeBatch({
        har: formatResult(
          'session.har',
          decoded([
            section('s', [observationOf('obs-1', { subject: { reference: 'Patient/s-1' } })]),
          ]),
          'har'
        ),
      })
    )
    const comparisons: PreviewPanelProps['comparisons'] = new Map([
      [
        LINKED_GROUP,
        new Map([['linked:Patient/s-1', { status: 'changed', fields: [GENDER_DIFF], server: {} }]]),
      ],
    ])
    render(<PreviewPanel {...panelProps(batch, { comparisons })} />)

    const group = within(screen.getByRole('region', { name: LINKED_RECORDS_HEADING }))
    expect(group.getByText('Patient')).toBeDefined()
    expect(group.queryByRole('checkbox')).toBeNull()
    expect(group.queryByRole('button', { name: /Edit/ })).toBeNull()
    expect(group.getByRole('button', { name: /Differs from server/ })).toBeDefined()
    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Import 2 resources' })).toBeDefined()
  })

  it('writes no provisional linked record once the only resource naming it is excluded', () => {
    const batch = withLinkedPractitioner(
      makeBatch({
        har: formatResult(
          'session.har',
          decoded([
            section('s', [
              observationOf('obs-1', { performer: [{ reference: 'Practitioner/pr-1' }] }),
            ]),
          ]),
          'har'
        ),
      })
    )
    const selectionFor = (): StagedImport.Selection =>
      StagedImport.toggleResource(StagedImport.initial(), 'obs-1')
    render(<PreviewPanel {...panelProps(batch, { selectionFor })} />)

    expect(screen.getByRole('region', { name: LINKED_RECORDS_HEADING })).toBeDefined()
    expect(screen.getByRole('heading', { name: NOTHING_TO_IMPORT_HEADING })).toBeDefined()
    expect(screen.queryByRole('button', { name: /^Import/ })).toBeNull()
  })

  it('offers the confirm for a changed stored copy alone once every resource naming it is excluded', () => {
    const batch = withLinkedPatient(
      makeBatch({
        har: formatResult(
          'session.har',
          decoded([
            section('s', [observationOf('obs-1', { subject: { reference: 'Patient/s-1' } })]),
          ]),
          'har'
        ),
      })
    )
    const selectionFor = (): StagedImport.Selection =>
      StagedImport.toggleResource(StagedImport.initial(), 'obs-1')
    render(<PreviewPanel {...panelProps(batch, { selectionFor })} />)

    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Import 1 resource (1 excluded)' })).toBeDefined()
  })

  it('shows nothing to import on a re-import whose rows and linked record the server holds unchanged', () => {
    const batch = withLinkedPatient(
      makeBatch({
        har: formatResult(
          'session.har',
          decoded([
            section('s', [observationOf('obs-1', { subject: { reference: 'Patient/s-1' } })]),
          ]),
          'har'
        ),
      })
    )
    // The screen pre-excludes the unchanged row and passes the unchanged
    // linked record's key.
    const selectionFor = (): StagedImport.Selection =>
      StagedImport.toggleResource(StagedImport.initial(), 'obs-1')
    render(
      <PreviewPanel
        {...panelProps(batch, {
          selectionFor,
          unchangedLinked: new Set(['linked:Patient/s-1']),
        })}
      />
    )

    expect(screen.getByRole('heading', { name: NOTHING_TO_IMPORT_HEADING })).toBeDefined()
    expect(screen.queryByRole('button', { name: /^Import/ })).toBeNull()
  })

  it('leaves an unchanged linked record out of the count while a resource naming it is written', () => {
    const batch = withLinkedPatient(
      makeBatch({
        har: formatResult(
          'session.har',
          decoded([
            section('s', [observationOf('obs-1', { subject: { reference: 'Patient/s-1' } })]),
          ]),
          'har'
        ),
      })
    )
    render(
      <PreviewPanel {...panelProps(batch, { unchangedLinked: new Set(['linked:Patient/s-1']) })} />
    )

    expect(screen.getByRole('button', { name: 'Import 1 resource' })).toBeDefined()
  })

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
    const batch: ResolvedBatch = {
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
      linked: [],
      links: [],
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
    const patientResource = Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))(onServer)
    const edited = Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
      ...onServer,
      gender: 'male',
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
      ['pat-1', { status: 'unchanged', fields: [], server: patientWire(onServer) }],
    ])
    const selectionFor = (): StagedImport.Selection =>
      StagedImport.edit(StagedImport.initial(), 'pat-1', edited)
    render(<PreviewPanel {...panelProps(batch, { comparisons, selectionFor })} />)

    await userEvent.click(screen.getByRole('button', { name: /Differs from server/ }))

    expect(screen.getByText('gender')).toBeDefined()
  })

  it('edits the resource to the server value when "keep server value" is clicked', async () => {
    const patientResource = Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
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

/** A gender the server has as male and the import as female. */
const GENDER_DIFF: FieldDiff = {
  path: ['gender'],
  server: valueSlot('male'),
  incoming: valueSlot('female'),
}

const patientWire = (wire: Record<string, unknown>): unknown =>
  Schema.encodeSync(Patient.Schema)(
    Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', ...wire })
  )

/** A pick with the given name, in the first batch slot. */
const pickedFile = (fileName: string): PickedFile.Type => ({
  id: `0:${fileName}`,
  fileName,
  bytes: new TextEncoder().encode('{}'),
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

/** Build a ResolvedBatch from partial format results. */
const makeBatch = (
  results: Partial<{ [K in FormatKind]: FormatDecode.Result<K> }>,
  unrecognizedFiles: readonly UnrecognizedFile[] = []
): ResolvedBatch => ({
  har: FormatDecode.emptyResult('har'),
  'lifelabs-pdf': FormatDecode.emptyResult('lifelabs-pdf'),
  dicom: FormatDecode.emptyResult('dicom'),
  ...results,
  unrecognizedFiles,
  linked: [],
  links: [],
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
  const resource = { resourceType, id } as FhirResourceWithId
  return { key, title, resource }
}

/** An Observation carrying the given reference fields, labeled under `key`, for a linked record to be named by. */
const observationOf = (key: string, references: object): DecodedFile.Resource => ({
  key,
  title: `Observation/${key}`,
  resource: Schema.decodeUnknownSync(withMandatoryId(Observation.Schema))({
    resourceType: 'Observation',
    id: key,
    status: 'final',
    code: { text: 'Heart rate' },
    ...references,
  }),
})

/** `batch` with `resource` as its one linked record, the link landing on it made by `target`. */
const withLinked = (
  batch: ResolvedBatch,
  resource: LinkableResource.WithId,
  target: (resource: LinkableResource.WithId) => LinkTarget.Type
): ResolvedBatch => {
  const literalReference = LinkableResource.literalReferenceOf(resource)
  const referent: Referent.ByMentionOnly = {
    _tag: 'ByMentionOnly',
    logicalReference: Option.getOrThrow(LinkableResource.tryIntoLogicalReference(resource)),
    label: literalReference,
  }
  return {
    ...batch,
    linked: [{ key: `linked:${literalReference}`, title: literalReference, resource }],
    links: [{ referent, target: target(resource) }],
  }
}

/** `batch` with the stored `Patient/s-1` as its one linked record: a stored copy. */
const withLinkedPatient = (batch: ResolvedBatch): ResolvedBatch =>
  withLinked(
    batch,
    Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
      resourceType: 'Patient',
      id: 's-1',
      identifier: [{ system: 'https://source.example/patient-id', value: 'mrn-1' }],
    }),
    (resource) => LinkTarget.Stored({ resource })
  )

/** `batch` with the provisional `Practitioner/pr-1` as its one linked record: a new one. */
const withLinkedPractitioner = (batch: ResolvedBatch): ResolvedBatch =>
  withLinked(
    batch,
    Schema.decodeUnknownSync(withMandatoryId(Practitioner.Schema))({
      resourceType: 'Practitioner',
      id: 'pr-1',
      identifier: [{ system: 'https://source.example/practitioner-name', value: 'Dr. One' }],
    }),
    (resource) => LinkTarget.Provisional({ resource })
  )

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
  batch: ResolvedBatch,
  overrides: {
    readonly onConfirm?: () => void
    readonly onSelectionChange?: PreviewPanelProps['onSelectionChange']
    readonly onSettingsChange?: PreviewPanelProps['onSettingsChange']
    readonly selectionFor?: PreviewPanelProps['selectionFor']
    readonly unchangedLinked?: PreviewPanelProps['unchangedLinked']
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
    unchangedLinked: overrides.unchangedLinked ?? new Set(),
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
