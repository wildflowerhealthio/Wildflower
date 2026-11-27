import { DateTime } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { importedRecordOf, storedOf, tyraWire } from './plan.test-helpers.ts'
import * as RecordText from './record-text.ts'

const NOW = DateTime.unsafeMake('2026-11-27T12:00:00Z')

describe('RecordText.titleOf', () => {
  it('names a Patient by the name she goes by', () => {
    const record = importedRecordOf(
      { resourceType: 'Patient', name: [{ family: 'Banks', given: ['Tyra'] }] },
      'Patient/p-1'
    )

    expect(RecordText.titleOf(NOW, record)).toBe('Tyra Banks')
  })

  it('names a Practitioner by the name they go by', () => {
    const record = importedRecordOf(
      { resourceType: 'Practitioner', name: [{ text: 'Dr. Jonathan Brown' }] },
      'Practitioner/pr-1'
    )

    expect(RecordText.titleOf(NOW, record)).toBe('Dr. Jonathan Brown')
  })

  it('names a person with no name by the title the plan shows', () => {
    const record = importedRecordOf({ resourceType: 'Patient' }, 'Patient/p-1')

    expect(RecordText.titleOf(NOW, record)).toBe('Patient/p-1')
  })

  it('names any other record by the title the plan shows', () => {
    const record = importedRecordOf(
      { resourceType: 'Observation', status: 'final', code: { text: 'Weight' } },
      'Weight · Observation'
    )

    expect(RecordText.titleOf(NOW, record)).toBe('Weight · Observation')
  })
})

describe('RecordText.titleOfResource', () => {
  it('names a stored person by the name they go by', () => {
    const patient = storedOf({ ...tyraWire(), id: 's-1' })

    expect(RecordText.titleOfResource(NOW, patient)).toBe('Tyra Banks')
  })

  it('names a stored person with no name, or any other stored resource, by its literal reference', () => {
    const patient = storedOf({ resourceType: 'Patient', id: 's-1' })
    const observation = storedOf({
      resourceType: 'Observation',
      id: 'o-1',
      status: 'final',
      code: { text: 'Weight' },
    })

    expect([
      RecordText.titleOfResource(NOW, patient),
      RecordText.titleOfResource(NOW, observation),
    ]).toEqual(['Patient/s-1', 'Observation/o-1'])
  })
})

describe('RecordText.fileTitleOf', () => {
  it('is the name of the file the record came from', () => {
    expect(RecordText.fileTitleOf(importedRecordOf(tyraWire(), 'Patient/p-1', 'b.har'))).toBe(
      'b.har'
    )
  })
})

describe('RecordText.statedIdentityFieldsOf', () => {
  it("lists a Patient's name, birth date and gender, each one she states, in that order", () => {
    const stated = storedOf({ ...tyraWire({ gender: 'female' }), id: 's-1' })
    const nameOnly = storedOf({ ...tyraWire({ birthDate: undefined }), id: 's-2' })

    expect([
      RecordText.statedIdentityFieldsOf(stated),
      RecordText.statedIdentityFieldsOf(nameOnly),
    ]).toEqual([['name', 'birthDate', 'gender'], ['name']])
  })

  it("lists a Practitioner's name, and nothing for another type", () => {
    const practitioner = storedOf({
      resourceType: 'Practitioner',
      id: 'pr-1',
      name: [{ text: 'Dr. Brown' }],
      gender: 'male',
    })
    const observation = storedOf({
      resourceType: 'Observation',
      id: 'o-1',
      status: 'final',
      code: { text: 'Weight' },
    })

    expect([
      RecordText.statedIdentityFieldsOf(practitioner),
      RecordText.statedIdentityFieldsOf(observation),
    ]).toEqual([['name'], []])
  })
})
