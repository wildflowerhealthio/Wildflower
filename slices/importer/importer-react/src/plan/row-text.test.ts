import { FhirResourceSchema, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import {
  PlannedRecord,
  type PlanResolution,
  RecordChoice,
  StoredMatch,
  Suggestion,
} from '@wildflowerhealthio/importer-fundamentals'
import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { importedRecordOf, READ_AT, storedOf, tyraWire } from './plan.test-helpers.ts'
import * as RowText from './row-text.ts'

/** `fields` as a record `a.har` brings, suggested to be saved as new. */
const plannedOf = (fields: object, title: string): PlannedRecord.Type =>
  PlannedRecord.make({
    record: importedRecordOf(fields, title),
    storedMatch: StoredMatch.makeEntry([], Option.none()),
    suggestion: Suggestion.make(Option.some(RecordChoice.SaveAsNewRecord()), Suggestion.NoMatch()),
  })

/** `planned` resolved as `label` under `id`, holding the references of the wire `resolvedFields`. */
const resolvedOf = (
  planned: PlannedRecord.Type,
  label: PlanResolution.Label,
  id: Option.Option<string>,
  resolvedFields: object = {}
): PlanResolution.ResolvedRecord => ({
  planned,
  label,
  id,
  resolvedReferences: ResourceReferences.collect(
    Schema.decodeUnknownSync(FhirResourceSchema)({
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'Resolved' },
      ...resolvedFields,
    })
  ),
  written: Option.none(),
})

/** The CPSO identifier Dr. Brown carries. */
const CPSO = { system: 'https://cpso.example/licence', value: '0083412' }

const tyra = resolvedOf(
  plannedOf(tyraWire({ gender: 'female' }), 'Patient/p-1'),
  'Create',
  Option.some('p-1')
)
const brown = resolvedOf(
  plannedOf(
    {
      resourceType: 'Practitioner',
      name: [{ family: 'Brown', prefix: ['Dr.'] }],
      identifier: [CPSO],
    },
    'Practitioner/pr-1'
  ),
  'DontAdd',
  Option.none()
)
/** An order no choice is made for yet, so a reference to it is not landed. */
const order = resolvedOf(
  plannedOf(
    {
      resourceType: 'ServiceRequest',
      status: 'active',
      intent: 'order',
      subject: { display: 'Tyra Banks' },
    },
    'ServiceRequest/order'
  ),
  'Open',
  Option.none()
)
const resolution: PlanResolution.Type = { records: [tyra, brown, order] }
const referencedRecords = RowText.referencedRecordsOf(READ_AT, resolution)

describe('RowText.rowTitleOf', () => {
  it('names a person by name, any other record by its summary, else by its title in the plan', () => {
    expect([
      RowText.rowTitleOf(READ_AT, tyra.planned),
      RowText.rowTitleOf(
        READ_AT,
        plannedOf(
          { resourceType: 'Observation', status: 'final', code: { text: 'Weight' } },
          'Observation/o-1'
        )
      ),
      RowText.rowTitleOf(
        READ_AT,
        plannedOf(
          { resourceType: 'DocumentReference', status: 'current', content: [{ attachment: {} }] },
          'portal-session.har'
        )
      ),
    ]).toEqual(['Tyra Banks', 'Weight', 'portal-session.har'])
  })
})

describe('RowText.existingRecordTitleOf', () => {
  it('names a stored person by name, any other stored record by its summary, else by its literal reference', () => {
    expect([
      RowText.existingRecordTitleOf(READ_AT, storedOf({ ...tyraWire(), id: 's-1' })),
      RowText.existingRecordTitleOf(
        READ_AT,
        storedOf({
          resourceType: 'Observation',
          id: 'o-1',
          status: 'final',
          code: { text: 'Weight' },
        })
      ),
      RowText.existingRecordTitleOf(
        READ_AT,
        storedOf({
          resourceType: 'DocumentReference',
          id: 'd-1',
          status: 'current',
          content: [{ attachment: {} }],
        })
      ),
    ]).toEqual(['Tyra Banks', 'Weight', 'DocumentReference/d-1'])
  })
})

describe('RowText.detailOf', () => {
  it('says a Patient’s birthDate and gender, and that one states no birthDate', () => {
    const undated = resolvedOf(
      plannedOf({ resourceType: 'Patient', name: [{ family: 'Banks' }] }, 'Patient/p-2'),
      'Create',
      Option.some('p-2')
    )
    expect([
      RowText.detailOf(READ_AT, referencedRecords, tyra),
      RowText.detailOf(READ_AT, referencedRecords, undated),
    ]).toEqual([
      RowText.RowDetail.Text({ text: '1990-01-02 · female' }),
      RowText.RowDetail.Text({ text: 'No birthDate' }),
    ])
  })

  it('gives a Practitioner’s first identifier, and says one carries none', () => {
    const unidentified = resolvedOf(
      plannedOf({ resourceType: 'Practitioner', name: [{ family: 'Grey' }] }, 'Practitioner/pr-2'),
      'Create',
      Option.some('pr-2')
    )
    expect([
      RowText.detailOf(READ_AT, referencedRecords, brown),
      RowText.detailOf(READ_AT, referencedRecords, unidentified),
    ]).toEqual([
      RowText.RowDetail.Identifier({ value: '0083412' }),
      RowText.RowDetail.Text({ text: 'No identifier' }),
    ])
  })

  it('names each reference, in the resource’s field order, by the record it names whatever its choice, display only where nothing is named', () => {
    // Arrange — a request for Tyra, by Dr. Brown, who is not added, seen by a nurse named only
    const request = resolvedOf(
      plannedOf(
        { resourceType: 'Observation', status: 'final', code: { text: 'Weight' } },
        'Observation/o-1'
      ),
      'Create',
      Option.some('o-1'),
      {
        subject: { reference: 'Patient/p-1', display: 'T. Banks' },
        performer: [
          { type: 'Practitioner', identifier: CPSO },
          { display: 'Nurse Joy' },
          { reference: 'Practitioner/elsewhere' },
        ],
        basedOn: [{ reference: 'ServiceRequest/stage-id' }],
      }
    )
    const unreferenced = resolvedOf(
      plannedOf(
        { resourceType: 'Observation', status: 'final', code: { text: 'Height' } },
        'Observation/o-2'
      ),
      'Create',
      Option.some('o-2')
    )

    // Act
    const details = [request, unreferenced].map((resolved) =>
      RowText.detailOf(READ_AT, referencedRecords, resolved)
    )

    // Assert
    expect(details).toEqual([
      RowText.RowDetail.Text({
        text: 'basedOn: ServiceRequest/order · performer: Brown (display only) · performer: Nurse Joy (display only) · performer: Practitioner/elsewhere · subject: Tyra Banks',
      }),
      RowText.RowDetail.Text({ text: 'No references' }),
    ])
  })
})
