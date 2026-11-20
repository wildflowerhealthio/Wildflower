import { type FhirResourceWithId, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { detached, OTHER_SOURCE, SOURCE, stored, tyraWire } from '../import-plan.test-helpers.ts'
import * as ChangedStoredRecord from './changed-stored-record.ts'
import * as RecordChoice from './record-choice.ts'

/**
 * Covers a stored record as it stands once the import's records make their
 * changes, in order, an edit among them; what is written for it; and the
 * one fold of records' choices over the stored records they use.
 */

const storedTyra = stored({ ...tyraWire('tyra'), id: 'p-1' })

/** The stored records `existing` among them, once records using it make `changes` in order. */
const changedBy = (
  existing: FhirResourceWithId,
  changes: readonly ChangedStoredRecord.Change[]
): ChangedStoredRecord.ByStoredRecord =>
  changes.reduce(
    (byStoredRecord, { resource, fieldsTaken, isEdit }) =>
      ChangedStoredRecord.withRecordChoice(
        byStoredRecord,
        Option.some(RecordChoice.UseExistingRecord({ existing, fieldsTaken })),
        { resource, isEdit }
      ),
    ChangedStoredRecord.noneChanged
  )

describe('ChangedStoredRecord.asItStandsIn', () => {
  it('should be the stored record itself while nothing changes it', () => {
    // Arrange / Act
    const asItStands = ChangedStoredRecord.asItStandsIn(changedBy(storedTyra, []), storedTyra)

    // Assert
    expect(asItStands).toBe(storedTyra)
  })

  it('should lay each change’s taken fields over the stored record, later ones winning, and join their identifiers', () => {
    // Arrange
    const first = detached(
      tyraWire('tyra', {
        gender: 'male',
        birthDate: '1991-03-04',
        identifier: [
          { system: SOURCE, value: 'tyra' },
          { system: OTHER_SOURCE, value: 'tyra-at-other' },
        ],
      })
    )
    const second = detached(tyraWire('tyra', { gender: 'female' }))
    const changed = changedBy(storedTyra, [
      { resource: first, fieldsTaken: HashSet.make('gender'), isEdit: false },
      { resource: second, fieldsTaken: HashSet.make('gender'), isEdit: false },
    ])

    // Act
    const asItStands = ChangedStoredRecord.asItStandsIn(changed, storedTyra)

    // Assert
    expect(
      asItStands.resourceType === 'Patient'
        ? {
            id: asItStands.id,
            gender: asItStands.gender,
            birthDate: asItStands.birthDate,
            identifiers: asItStands.identifier.map(({ value }) => value),
          }
        : null
    ).toEqual({
      id: 'p-1',
      gender: 'female',
      birthDate: '1990-01-02',
      identifiers: ['tyra', 'tyra-at-other'],
    })
  })
})

/** A patient's gender, birth date and identifier values, or `null` for another resource. */
const demographicsOf = (resource: FhirResourceWithId): unknown =>
  resource.resourceType === 'Patient'
    ? {
        id: resource.id,
        gender: resource.gender,
        birthDate: resource.birthDate,
        identifiers: resource.identifier.map(({ value }) => value),
      }
    : null

describe('ChangedStoredRecord.asItStandsIn, an edit among the changes', () => {
  it('should replace the stored record with the last edit, lay later taken fields over it, and keep every identifier', () => {
    // Arrange
    const storedWithOther = stored({
      ...tyraWire('tyra'),
      id: 'p-1',
      identifier: [
        { system: SOURCE, value: 'tyra' },
        { system: OTHER_SOURCE, value: 'kept' },
      ],
    })
    const edit = detached(tyraWire('tyra', { gender: 'other', birthDate: '1991-01-01' }))
    const later = detached(tyraWire('tyra', { gender: 'female' }))
    const changed = changedBy(storedWithOther, [
      { resource: edit, fieldsTaken: HashSet.make('birthDate'), isEdit: true },
      { resource: later, fieldsTaken: HashSet.make('gender'), isEdit: false },
    ])

    // Act
    const asItStands = ChangedStoredRecord.asItStandsIn(changed, storedWithOther)

    // Assert
    expect(demographicsOf(asItStands)).toEqual({
      id: 'p-1',
      gender: 'female',
      birthDate: '1991-01-01',
      identifiers: ['tyra', 'kept'],
    })
  })
})

describe('ChangedStoredRecord.writtenIn', () => {
  it.each([
    { name: 'nothing changes it', change: Option.none(), written: false },
    {
      name: 'a change takes nothing and adds no identifier',
      change: Option.some({
        resource: detached(tyraWire('tyra')),
        fieldsTaken: HashSet.empty(),
        isEdit: false,
      }),
      written: false,
    },
    {
      name: 'a change only adds an identifier',
      change: Option.some({
        resource: detached(tyraWire('tyra-at-other', {}, OTHER_SOURCE)),
        fieldsTaken: HashSet.empty(),
        isEdit: false,
      }),
      written: true,
    },
    {
      name: 'a change takes a field',
      change: Option.some({
        resource: detached(tyraWire('tyra', { gender: 'female' })),
        fieldsTaken: HashSet.make('gender'),
        isEdit: false,
      }),
      written: true,
    },
    {
      name: 'the reviewer edits it',
      change: Option.some({
        resource: detached(tyraWire('tyra')),
        fieldsTaken: HashSet.empty(),
        isEdit: true,
      }),
      written: true,
    },
  ])(
    'should write the stored record only when something changes it: $name',
    ({ change, written }) => {
      // Arrange
      const changed = changedBy(storedTyra, Option.toArray(change))

      // Act
      const writtenForm = ChangedStoredRecord.writtenIn(changed, storedTyra)

      // Assert
      expect(Option.map(writtenForm, literalReferenceOf)).toEqual(
        written ? Option.some('Patient/p-1') : Option.none()
      )
    }
  )
})

describe('ChangedStoredRecord.withRecordChoice', () => {
  it('should fold each choice that uses a stored record into it in order, and change nothing for any other choice', () => {
    // Arrange
    const useStored = RecordChoice.UseExistingRecord({
      existing: storedTyra,
      fieldsTaken: HashSet.make('gender'),
    })
    const steps = [
      { choice: Option.some(useStored), resource: detached(tyraWire('tyra', { gender: 'male' })) },
      { choice: Option.some(RecordChoice.SaveAsNewRecord()), resource: detached(tyraWire('x')) },
      { choice: Option.none(), resource: detached(tyraWire('y')) },
      {
        choice: Option.some(useStored),
        resource: detached(tyraWire('tyra', { gender: 'female' })),
      },
    ]

    // Act
    const byStoredRecord = steps.reduce(
      (changed, { choice, resource }) =>
        ChangedStoredRecord.withRecordChoice(changed, choice, { resource, isEdit: false }),
      ChangedStoredRecord.noneChanged
    )

    // Assert
    expect({
      asItStands: demographicsOf(ChangedStoredRecord.asItStandsIn(byStoredRecord, storedTyra)),
      written: Option.map(
        ChangedStoredRecord.writtenIn(byStoredRecord, storedTyra),
        literalReferenceOf
      ),
      untouched: ChangedStoredRecord.asItStandsIn(byStoredRecord, { ...storedTyra, id: 'p-2' }).id,
    }).toEqual({
      asItStands: {
        id: 'p-1',
        gender: 'female',
        birthDate: '1990-01-02',
        identifiers: ['tyra'],
      },
      written: Option.some('Patient/p-1'),
      untouched: 'p-2',
    })
  })
})
