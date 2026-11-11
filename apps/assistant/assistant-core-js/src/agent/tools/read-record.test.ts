import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { stubFhirRecords } from '../../test-helpers.ts'
import {
  ada,
  everyone,
  toolsFor,
  runCall,
  succeeded,
  failed,
  observation,
} from './tools.test-helpers.ts'

describe('Tools.run read_record', () => {
  it("should read a record about the chat's patient, or about no patient", () => {
    const practitioner = { resourceType: 'Practitioner', id: 'dr1', name: [{ text: 'Dr Who' }] }
    const server = stubFhirRecords({
      'Observation/o1': Effect.succeed(observation('o1', 'p1')),
      'Practitioner/dr1': Effect.succeed(practitioner),
    })
    const tools = toolsFor(ada)

    expect(
      runCall(tools, server, 'read_record', { resourceType: 'Observation', id: 'o1' })
    ).toEqual(succeeded(observation('o1', 'p1')))
    expect(
      runCall(tools, server, 'read_record', { resourceType: 'Practitioner', id: 'dr1' })
    ).toEqual(succeeded(practitioner))
  })

  it('should refuse a record about another patient', () => {
    const server = stubFhirRecords({ 'Observation/o2': Effect.succeed(observation('o2', 'p2')) })

    const result = runCall(toolsFor(ada), server, 'read_record', {
      resourceType: 'Observation',
      id: 'o2',
    })

    expect(result).toEqual(
      failed(
        "This record is about another patient, so it isn't shown: this chat is about one patient."
      )
    )
  })

  it('should refuse an id outside FHIR’s id grammar, reading nothing', () => {
    const server = stubFhirRecords({})

    expect(
      runCall(toolsFor(everyone), server, 'read_record', { resourceType: 'Patient', id: '../p2' })
    ).toEqual(failed('"../p2" isn\'t a FHIR id.'))
    expect(server.readPaths).toEqual([])
  })
})
