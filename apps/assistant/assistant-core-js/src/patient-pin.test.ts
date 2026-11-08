import { Either, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as PatientPin from './patient-pin.ts'

const code = { name: 'code', value: '4548-4' }

describe('PatientPin.of', () => {
  it.each([
    ['Patient', Option.some({ kind: 'the-patient' })],
    ['Observation', Option.some({ kind: 'by-reference', parameter: 'patient' })],
    ['AdverseEvent', Option.some({ kind: 'by-reference', parameter: 'subject' })],
    ['Practitioner', Option.some({ kind: 'not-patient-specific' })],
    ['Group', Option.none()],
    ['Schedule', Option.none()],
  ] as const)('should keep %s to one patient as %j', (resourceType, pin) => {
    expect(PatientPin.of(resourceType)).toEqual(pin)
  })
})

describe('PatientPin.pinnedParamsOf', () => {
  it.each([
    ['Patient', [code, { name: '_id', value: 'p1' }]],
    ['Observation', [code, { name: 'patient', value: 'p1' }]],
    ['AdverseEvent', [code, { name: 'subject', value: 'Patient/p1' }]],
    ['Practitioner', [code]],
  ] as const)('should add the parameter that keeps a %s search to the patient', (type, params) => {
    const pin = Option.getOrThrow(PatientPin.of(type))

    expect(PatientPin.pinnedParamsOf(pin, 'p1', [code])).toEqual(Either.right(params))
  })

  it.each([
    ['Observation', 'patient'],
    ['Observation', 'subject'],
    ['Observation', 'subject:Patient'],
    ['Observation', 'patient.name'],
    ['AdverseEvent', 'patient'],
    ['Patient', '_id'],
    ['Patient', '_id:not'],
  ] as const)(
    'should refuse a %s search setting %s, which names whose records to read',
    (type, name) => {
      const pin = Option.getOrThrow(PatientPin.of(type))

      expect(PatientPin.pinnedParamsOf(pin, 'p1', [code, { name, value: 'p2' }])).toEqual(
        Either.left(name)
      )
    }
  )
})

describe('PatientPin.isAboutAnotherPatient', () => {
  it.each([
    [{ resourceType: 'Patient', id: 'p1' }, false],
    [{ resourceType: 'Patient', id: 'p2' }, true],
    [{ resourceType: 'Observation', id: 'o1', subject: { reference: 'Patient/p1' } }, false],
    [{ resourceType: 'Observation', id: 'o1', subject: { reference: 'Patient/p2' } }, true],
    [
      { resourceType: 'Observation', subject: { reference: 'https://fhir.example/r4/Patient/p2' } },
      true,
    ],
    [{ resourceType: 'Observation', subject: { reference: 'Patient/p1/_history/3' } }, false],
    [{ resourceType: 'AllergyIntolerance', patient: { reference: 'Patient/p2' } }, true],
    [{ resourceType: 'Practitioner', id: 'dr1' }, false],
    [{ resourceType: 'Observation', subject: { reference: 'Group/g1' } }, false],
    ['not a record', true],
  ] as const)('should say whether %j is about a patient other than p1: %s', (record, about) => {
    expect(PatientPin.isAboutAnotherPatient(record, 'p1')).toBe(about)
  })
})
