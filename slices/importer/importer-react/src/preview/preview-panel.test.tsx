import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { DiffSlot, FieldDiff, ServerComparison } from '@wildflowerhealthio/fhir-r4/clients'
import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { Observation, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import {
  defaultFormatSettings,
  type FormatKind,
  type FormatSettings,
  type ResolvedBatch,
  ReviewGroup,
  type UnrecognizedFile,
} from '@wildflowerhealthio/importer-core'
import {
  type DecodedFile,
  LinkableResource,
  LinkPlan,
  LinkTarget,
  type PickedFile,
  type Referent,
  Section,
  SectionedList,
  StagedImport,
} from '@wildflowerhealthio/importer-fundamentals'
import { Option, Schema, type ParseResult } from 'effect'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { PreviewPanel, type PreviewPanelProps, type SettingsRegistry } from './preview-panel.tsx'
import {
  LINKED_RECORDS_HEADING,
  NO_RESOURCES_MESSAGE,
  NOTHING_TO_IMPORT_HEADING,
  PREVIEW_HEADING,
  UNREADABLE_FILE_MESSAGE,
  UNRECOGNIZED_FILE_MESSAGE,
} from './preview-text.ts'

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
        har: formatEntry(
          'session.har',
          decoded([
            section('s', [observationOf('obs-1', { subject: { reference: 'Patient/s-1' } })]),
          ])
        ),
      })
    )
    const comparisons: PreviewPanelProps['comparisons'] = new Map([
      [
        ReviewGroup.LINKED,
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

  it('offers the confirm for a changed stored copy alone once every resource naming it is excluded', () => {
    const batch = withLinkedPatient(
      makeBatch({
        har: formatEntry(
          'session.har',
          decoded([
            section('s', [observationOf('obs-1', { subject: { reference: 'Patient/s-1' } })]),
          ])
        ),
      })
    )
    const selectionFor = (): StagedImport.Selection =>
      StagedImport.toggleResource(StagedImport.initial(), NONE_BY_DEFAULT, 'obs-1')
    render(<PreviewPanel {...panelProps(batch, { selectionFor })} />)

    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Import 1 resource (1 excluded)' })).toBeDefined()
  })

  it('shows nothing to import on a re-import whose rows and linked record the server holds unchanged', () => {
    const batch = withLinkedPatient(
      makeBatch({
        har: formatEntry(
          'session.har',
          decoded([
            section('s', [observationOf('obs-1', { subject: { reference: 'Patient/s-1' } })]),
          ])
        ),
      })
    )
    // The screen pre-excludes the unchanged row and passes the unchanged
    // linked record's key.
    const selectionFor = (): StagedImport.Selection =>
      StagedImport.toggleResource(StagedImport.initial(), NONE_BY_DEFAULT, 'obs-1')
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
        har: formatEntry(
          'session.har',
          decoded([
            section('s', [observationOf('obs-1', { subject: { reference: 'Patient/s-1' } })]),
          ])
        ),
      })
    )
    render(
      <PreviewPanel {...panelProps(batch, { unchangedLinked: new Set(['linked:Patient/s-1']) })} />
    )

    expect(screen.getByRole('button', { name: 'Import 1 resource' })).toBeDefined()
  })

  it('renders nothing-to-import when no format decoded any resource', () => {
    const batch = makeBatch({ har: formatEntry('empty.har', decoded([])) })
    render(<PreviewPanel {...panelProps(batch)} />)

    expect(screen.getByRole('heading', { name: NOTHING_TO_IMPORT_HEADING })).toBeDefined()
    expect(screen.getByText(NO_RESOURCES_MESSAGE)).toBeDefined()
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined()
  })

  it('renders a preview heading and a confirm naming the included-resource total', async () => {
    const onConfirm = vi.fn()
    const batch = makeBatch({
      har: formatEntry(
        'session.har',
        decoded([
          section('https://r4.example.org/Patient/pat-1', [
            labeledResource('pat-1', 'Patient/pat-1'),
            labeledResource('obs-1', 'Observation/obs-1'),
          ]),
        ])
      ),
    })
    render(<PreviewPanel {...panelProps(batch, { onConfirm })} />)

    expect(screen.getByRole('heading', { name: PREVIEW_HEADING })).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 resources' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('counts two rows under one Type/id once, as the transaction writes them', () => {
    const batch = makeBatch({
      har: formatEntry(
        'a.har',
        decoded([section('s', [labeledResource('a/pat-1', 'Patient/pat-1')])])
      ),
      'lifelabs-pdf': formatEntry(
        'b.pdf',
        decoded([
          section('s', [
            labeledResource('b/pat-1', 'Patient/pat-1'),
            labeledResource('b/obs-1', 'Observation/obs-1'),
          ]),
        ])
      ),
    })
    render(<PreviewPanel {...panelProps(batch)} />)

    expect(screen.getByRole('button', { name: 'Import 2 resources' })).toBeDefined()
  })

  it('renders each decoded section under its own title with per-resource include checkboxes', () => {
    const batch = makeBatch({
      'lifelabs-pdf': formatEntry(
        'reports.pdf',
        decoded([
          section('Lab No 2024-JJ1 — Aug 13 2026 13:02', [labeledResource('p1', 'Patient/p1')]),
          section('Lab No 2024-JJ2 — Aug 20 2026 09:15', [labeledResource('o1', 'Observation/o1')]),
        ])
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
    const batch = makeBatch(
      {
        har: {
          files: [pickedFile('a.har'), pickedFile('broken.har'), pickedFile('c.har')],
          group: {
            decodedFile: decoded([
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
        },
      },
      [
        {
          id: 'x',
          title: 'notes.txt',
          files: [pickedFile('notes.txt')],
        },
      ]
    )
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
      har: formatEntry(
        'session.har',
        decoded(
          [section('https://a', [labeledResource('pat-1', 'Patient/pat-1')])],
          [
            'Matched no importer: https://example.org/tracker.js',
            'The archive captured no response body: https://a/empty',
          ]
        )
      ),
    })
    render(<PreviewPanel {...panelProps(batch)} />)

    expect(screen.getByText('2 notes')).toBeDefined()
    expect(screen.getByText('Matched no importer: https://example.org/tracker.js')).toBeDefined()
  })

  it('renders no settings form for HAR, and reports a LifeLabs settings change against its format', async () => {
    const onSettingsChange = vi.fn()
    const batch = makeBatch({
      har: formatEntry(
        'a.har',
        decoded([section('https://a', [labeledResource('p', 'Patient/p')])])
      ),
      'lifelabs-pdf': formatEntry(
        'r.pdf',
        decoded([section('Lab No 1', [labeledResource('o', 'Observation/o')])])
      ),
    })
    render(<PreviewPanel {...panelProps(batch, { onSettingsChange })} />)

    // One group per format, titled by the format's display title; only
    // LifeLabs, which has settings, carries the settings form's box.
    const harGroup = screen.getByRole('region', { name: 'HAR archive' })
    const lifeLabsGroup = screen.getByRole('region', { name: 'LifeLabs report' })
    const lifeLabsPicker = within(lifeLabsGroup).getByRole('button', {
      name: 'change lifelabs settings',
    })
    const settingsFormClass = lifeLabsPicker.parentElement?.className ?? ''
    expect(settingsFormClass).not.toBe('')
    expect(harGroup.getElementsByClassName(settingsFormClass)).toHaveLength(0)

    await userEvent.click(lifeLabsPicker)
    expect(onSettingsChange).toHaveBeenCalledWith(
      'lifelabs-pdf',
      defaultFormatSettings['lifelabs-pdf']
    )
  })

  it("mounts each format's own settings picker, DICOM included", async () => {
    const onSettingsChange = vi.fn()
    const batch = makeBatch({
      dicom: formatEntry(
        'scan.dcm',
        decoded([section('CT Chest', [labeledResource('s', 'Patient/s')])])
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
      har: formatEntry(
        'session.har',
        decoded([section('https://a', [labeledResource('pat-1', 'Patient/pat-1')])])
      ),
    })
    render(<PreviewPanel {...panelProps(batch, { confirming: true })} />)

    const confirm = screen.getByRole('button', { name: /Importing…/ })
    expect(confirm.getAttribute('disabled')).not.toBeNull()
  })

  it('reports a toggled-off resource through onSelectionChange keyed by format kind', async () => {
    const onSelectionChange = vi.fn()
    const batch = makeBatch({
      har: formatEntry(
        'session.har',
        decoded([
          section('https://a', [
            labeledResource('pat-1', 'Patient/pat-1'),
            labeledResource('obs-1', 'Observation/obs-1'),
          ]),
        ])
      ),
    })
    render(<PreviewPanel {...panelProps(batch, { onSelectionChange })} />)

    await userEvent.click(screen.getByRole('checkbox', { name: /Include Patient/ }))

    expect(onSelectionChange).toHaveBeenCalledWith(
      'har',
      StagedImport.toggleResource(StagedImport.initial(), NONE_BY_DEFAULT, 'pat-1')
    )
  })

  it('opts a whole section out in one click when every resource was included', async () => {
    const onSelectionChange = vi.fn()
    const batch = makeBatch({
      'lifelabs-pdf': formatEntry(
        'reports.pdf',
        decoded([
          section('Lab No 2024-JJ1', [
            labeledResource('p1', 'Patient/p1'),
            labeledResource('o1', 'Observation/o1'),
          ]),
        ])
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
    const partial = StagedImport.toggleResource(StagedImport.initial(), NONE_BY_DEFAULT, 'o1')
    const batch = makeBatch({
      'lifelabs-pdf': formatEntry(
        'reports.pdf',
        decoded([
          section('Lab No 2024-JJ1', [
            labeledResource('p1', 'Patient/p1'),
            labeledResource('o1', 'Observation/o1'),
          ]),
        ])
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

  it('leaves out a row the default excludes, and records a tick on it as the reviewer’s inclusion', async () => {
    const onSelectionChange = vi.fn()
    const batch = makeBatch({
      har: formatEntry(
        'a.har',
        decoded([
          section('s', [labeledResource('p1', 'Patient/p1'), labeledResource('p2', 'Patient/p2')]),
        ])
      ),
    })
    render(
      <PreviewPanel
        {...panelProps(batch, {
          onSelectionChange,
          excludedByDefaultFor: () => new Set(['p2']),
        })}
      />
    )
    expect(screen.getByRole('button', { name: 'Import 1 resource (1 excluded)' })).toBeDefined()

    await userEvent.click(screen.getByRole('checkbox', { name: /Include Patient.*p2/ }))

    expect(onSelectionChange).toHaveBeenCalledWith(
      'har',
      StagedImport.setResourcesIncluded(StagedImport.initial(), ['p2'], true)
    )
  })

  it('shows a static badge for a resource the server does not hold', () => {
    const batch = makeBatch({
      har: formatEntry(
        'a.har',
        decoded([section('s', [labeledResource('pat-1', 'Patient/pat-1')])])
      ),
    })
    const comparisons = comparisonsFor('har', [['pat-1', { status: 'new', fields: [] }]])

    render(<PreviewPanel {...panelProps(batch, { comparisons })} />)

    expect(screen.getByText('New')).toBeDefined()
  })

  it('reveals the field-level diffs when the changed badge is clicked', async () => {
    const batch = makeBatch({
      har: formatEntry('a.har', decoded([section('s', [FEMALE_PAT_1])])),
    })
    const comparisons = comparisonsFor('har', [
      [
        'pat-1',
        {
          status: 'changed',
          fields: [GENDER_DIFF],
          server: patientWire({ resourceType: 'Patient', id: 'pat-1', gender: 'male' }),
        },
      ],
    ])
    render(<PreviewPanel {...panelProps(batch, { comparisons })} />)

    await userEvent.click(screen.getByRole('button', { name: /Differs from server/ }))

    expect(screen.getByText('gender')).toBeDefined()
    expect(screen.getByText('"male"')).toBeDefined()
    expect(screen.getByText('"female"')).toBeDefined()
  })

  it('reveals the field-level diffs when the changed badge is hovered', async () => {
    const batch = makeBatch({
      har: formatEntry('a.har', decoded([section('s', [FEMALE_PAT_1])])),
    })
    const comparisons = comparisonsFor('har', [
      [
        'pat-1',
        {
          status: 'changed',
          fields: [GENDER_DIFF],
          server: patientWire({ resourceType: 'Patient', id: 'pat-1', gender: 'male' }),
        },
      ],
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
    const labeled: DecodedFile.Row = {
      reviewable: { key: 'pat-1', title: 'Patient/pat-1', origin: 'Decoded' },
      resource: patientResource,
    }
    const batch = makeBatch({
      har: formatEntry('a.har', decoded([section('s', [labeled])])),
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
    const labeled: DecodedFile.Row = {
      reviewable: { key: 'pat-1', title: 'Patient/pat-1', origin: 'Decoded' },
      resource: patientResource,
    }
    const batch = makeBatch({
      har: formatEntry('a.har', decoded([section('s', [labeled])])),
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

/** The Patient `pat-1` as the import has her: female, where the server has male. */
const FEMALE_PAT_1: DecodedFile.Row = {
  reviewable: { key: 'pat-1', title: 'Patient/pat-1', origin: 'Decoded' },
  resource: Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
    resourceType: 'Patient',
    id: 'pat-1',
    gender: 'female',
  }),
}

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

/** One format's part of a batch: its picked files and its review group. */
interface FormatEntry {
  readonly files: readonly PickedFile.Type[]
  readonly group: ReviewGroup.Type
}

/** A format of one picked file, named `fileName`, whose group holds `decodedFile`. */
const formatEntry = (fileName: string, decodedFile: DecodedFile.DecodedFile): FormatEntry => ({
  files: [pickedFile(fileName)],
  group: { decodedFile, unreadableFiles: [] },
})

/** Build a ResolvedBatch from the claimed formats' entries. */
const makeBatch = (
  entries: { readonly [K in FormatKind]?: FormatEntry },
  unrecognizedFiles: readonly UnrecognizedFile[] = []
): ResolvedBatch => {
  const claimed = Object.entries(entries)
  const groups = Object.fromEntries(claimed.map(([kind, { group }]) => [kind, group]))
  return {
    groups,
    plan: LinkPlan.empty,
    decoded: {
      groups,
      files: Object.fromEntries(claimed.map(([kind, { files }]) => [kind, files])),
      unrecognizedFiles,
    },
  }
}

/** Verdicts for a format, keyed by format kind. */
const comparisonsFor = (
  format: FormatKind,
  entries: readonly (readonly [string, ServerComparison])[]
): PreviewPanelProps['comparisons'] => new Map([[format, new Map(entries)]])

/** A decoded file from sections and optional notes. */
const decoded = (
  sections: readonly Section.Type<DecodedFile.Row>[],
  notes: readonly string[] = []
): DecodedFile.DecodedFile => ({ sectionedList: SectionedList.make(sections), notes })

/** One titled section holding the given resources. */
const section = (
  title: string,
  resources: readonly DecodedFile.Row[]
): Section.Type<DecodedFile.Row> => Section.make(title, resources)

/**
 * A labeled resource for the panel to count and display: a bare Patient, or
 * an Observation about a patient with an empty code, each summarised by its
 * `Type/id`.
 */
const labeledResource = (key: string, title: string): DecodedFile.Row => {
  const [resourceType = 'Patient', id = key] = title.split('/')
  const resource =
    resourceType === 'Observation'
      ? observationOf(key, { code: {}, subject: { reference: 'Patient/p' } }).resource
      : Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({ resourceType: 'Patient', id })
  return { reviewable: { key, title, origin: 'Decoded' }, resource: { ...resource, id } }
}

/** An Observation carrying the given reference fields, labeled under `key`, for a linked record to be named by. */
const observationOf = (key: string, references: object): DecodedFile.Row => ({
  reviewable: { key, title: `Observation/${key}`, origin: 'Decoded' },
  resource: Schema.decodeUnknownSync(withMandatoryId(Observation.Schema))({
    resourceType: 'Observation',
    id: key,
    status: 'final',
    code: { text: 'Heart rate' },
    ...references,
  }),
})

/** `batch` with the stored `Patient/s-1` as its one linked record: a stored copy. */
const withLinkedPatient = (batch: ResolvedBatch): ResolvedBatch => {
  const resource = Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
    resourceType: 'Patient',
    id: 's-1',
    identifier: [{ system: 'https://source.example/patient-id', value: 'mrn-1' }],
  })
  const literalReference = LinkableResource.literalReferenceOf(resource)
  const logicalReference = Option.getOrThrow(LinkableResource.tryIntoLogicalReference(resource))
  const referent: Referent.Type = {
    logicalReference,
    identifiers: logicalReference.identifier,
    derivedIdentifier: Option.none(),
    resource,
    reviewable: { key: 'k-s-1', title: literalReference, origin: 'Decoded' },
    label: literalReference,
  }
  return {
    ...batch,
    groups: {
      ...batch.groups,
      linked: ReviewGroup.linked([
        {
          reviewable: {
            key: `linked:${literalReference}`,
            title: literalReference,
            origin: 'Decoded',
          },
          resource,
        },
      ]),
    },
    plan: { ...LinkPlan.empty, links: [{ referent, target: LinkTarget.Stored({ resource }) }] },
  }
}

/**
 * A settings registry whose pickers are one-button stubs reporting the default
 * settings back; HAR, which has no settings, has no picker.
 */
const settingsRegistry: SettingsRegistry = {
  har: { display: { title: 'HAR archive', description: 'HAR' } },
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

/** No row out by default. */
const NONE_BY_DEFAULT: ReadonlySet<string> = new Set()

/** Shared panel props wired to synthetic lookups. */
const panelProps = (
  batch: ResolvedBatch,
  overrides: {
    readonly onConfirm?: () => void
    readonly onSelectionChange?: PreviewPanelProps['onSelectionChange']
    readonly onSettingsChange?: PreviewPanelProps['onSettingsChange']
    readonly selectionFor?: PreviewPanelProps['selectionFor']
    readonly excludedByDefaultFor?: PreviewPanelProps['excludedByDefaultFor']
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
    excludedByDefaultFor: overrides.excludedByDefaultFor ?? (() => NONE_BY_DEFAULT),
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
