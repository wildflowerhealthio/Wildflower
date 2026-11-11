import { Either } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { stubFhirRecords } from '../../test-helpers.ts'
import {
  ada,
  everyone,
  accessOf,
  toolsFor,
  failed,
  proposeCall,
  weight,
} from './tools.test-helpers.ts'

describe('Tools.propose create_record', () => {
  it("should propose the record with its subject replaced by a reference to the chat's patient", () => {
    const proposal = proposeCall(toolsFor(ada), stubFhirRecords({}), 'create_record', {
      ...weight,
      subject: {
        reference: 'Patient/p1',
        display: 'Bob',
        identifier: { system: 'urn:mrn', value: 'bob-1' },
      },
    })

    expect(proposal).toEqual(
      Either.right({
        kind: 'create',
        callId: 'call-1',
        resource: { ...weight, subject: { reference: 'Patient/p1' } },
      })
    )
  })

  it("should point a relative or unset subject at the chat's patient", () => {
    expect(
      proposeCall(toolsFor(ada), stubFhirRecords({}), 'create_record', { ...weight, subject: {} })
    ).toEqual(
      Either.right({
        kind: 'create',
        callId: 'call-1',
        resource: { ...weight, subject: { reference: 'Patient/p1' } },
      })
    )
  })

  it.each([
    [
      'a record about another patient',
      { ...weight, subject: { reference: 'Patient/p2' } },
      "This record is about another patient, so it can't be created: this chat is about one patient.",
    ],
    [
      'a record about a patient with no reference to them',
      weight,
      'A Observation is about a patient: add its subject or patient reference (whichever the type has), and the tool points it at Patient/p1, the patient this chat is about.',
    ],
    [
      'a new Patient',
      { resourceType: 'Patient', name: [{ family: 'Byron' }] },
      "This chat is about one patient, so it can't create a Patient: a new patient isn't this one.",
    ],
    [
      'a record with an id',
      { ...weight, id: 'mine', subject: { reference: 'Patient/p1' } },
      'Leave out the id: the server assigns one to a new record.',
    ],
    [
      'a record containing a record about another patient',
      {
        ...weight,
        subject: { reference: 'Patient/p1' },
        contained: [{ ...weight, id: 'c1', subject: { reference: 'Patient/p2' } }],
      },
      "This record is about another patient, so it can't be created: this chat is about one patient.",
    ],
  ])('should refuse %s in a chat about one patient', (_case, resource, reason) => {
    expect(proposeCall(toolsFor(ada), stubFhirRecords({}), 'create_record', resource)).toEqual(
      Either.left(failed(reason))
    )
  })

  it('should propose a record about no one patient as given', () => {
    const practitioner = { resourceType: 'Practitioner', name: [{ family: 'Who' }] }

    expect(proposeCall(toolsFor(ada), stubFhirRecords({}), 'create_record', practitioner)).toEqual(
      Either.right({ kind: 'create', callId: 'call-1', resource: practitioner })
    )
  })

  it('should propose any record as given in a chat about every patient', () => {
    const forBob = { ...weight, subject: { reference: 'Patient/p2' } }

    expect(proposeCall(toolsFor(everyone), stubFhirRecords({}), 'create_record', forBob)).toEqual(
      Either.right({ kind: 'create', callId: 'call-1', resource: forBob })
    )
  })

  it("should not offer a type it can't point at the patient in a chat about one", () => {
    expect(toolsFor(ada).creatableTypes).not.toContain('Coverage')
    expect(toolsFor(ada).creatableTypes).toContain('Observation')
    expect(toolsFor(everyone).creatableTypes).toContain('Coverage')
  })

  it('should refuse a type the grant cannot create', () => {
    const tools = toolsFor(everyone, accessOf('patient/Condition.c'))

    expect(proposeCall(tools, stubFhirRecords({}), 'create_record', weight)).toEqual(
      Either.left(failed("Observation isn't one of the record types this tool can reach."))
    )
  })
})
