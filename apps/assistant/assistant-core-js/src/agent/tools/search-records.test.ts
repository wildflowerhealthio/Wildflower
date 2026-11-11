import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { FhirReadFailed } from '../../fhir-records.ts'
import { fhirFailure, searchBundleOf, stubFhirRecords } from '../../test-helpers.ts'
import * as Tools from './index.ts'
import {
  ada,
  everyone,
  accessOf,
  toolsFor,
  runCall,
  succeeded,
  failed,
  observation,
} from './tools.test-helpers.ts'

describe('Tools.run search_records', () => {
  it('should read one page pinned to the patient, 20 records unless asked', () => {
    const server = stubFhirRecords({
      'Observation?': Effect.succeed(searchBundleOf([observation('o1', 'p1')], { total: 1 })),
    })

    const result = runCall(toolsFor(ada), server, 'search_records', {
      resourceType: 'Observation',
      params: [{ name: 'code', value: 'http://loinc.org|4548-4' }],
    })

    expect(server.readPaths).toEqual([
      'Observation?code=http%3A%2F%2Floinc.org%7C4548-4&patient=p1&_count=20',
    ])
    expect(result).toEqual(
      succeeded({ resources: [observation('o1', 'p1')], total: 1, more: false })
    )
  })

  it.each([
    ['Patient', '_id=p1'],
    ['AdverseEvent', 'subject=Patient%2Fp1'],
    ['Practitioner', ''],
  ] as const)('should pin a %s search with %s', (resourceType, pinned) => {
    const server = stubFhirRecords({ '': Effect.succeed(searchBundleOf([])) })

    runCall(toolsFor(ada), server, 'search_records', { resourceType, params: [] })

    expect(server.readPaths).toEqual([
      `${resourceType}?${pinned === '' ? '' : `${pinned}&`}_count=20`,
    ])
  })

  it('should search every patient unpinned, and hold _count to 50', () => {
    const server = stubFhirRecords({ 'Observation?': Effect.succeed(searchBundleOf([])) })

    runCall(toolsFor(everyone), server, 'search_records', {
      resourceType: 'Observation',
      params: [{ name: '_count', value: '80' }],
    })

    expect(server.readPaths).toEqual(['Observation?_count=50'])
  })

  it.each([
    [[{ name: '_count', value: 'ten' }], '_count must be a whole number of at least 1.'],
    [[{ name: '_count', value: '0' }], '_count must be a whole number of at least 1.'],
    [[{ name: 'code&patient', value: 'x' }], '"code&patient" isn\'t a search parameter name.'],
  ])('should refuse the parameters %j, reading nothing', (params, reason) => {
    const server = stubFhirRecords({ '': Effect.succeed(searchBundleOf([])) })

    expect(
      runCall(toolsFor(everyone), server, 'search_records', { resourceType: 'Observation', params })
    ).toEqual(failed(reason))
    expect(server.readPaths).toEqual([])
  })

  it('should answer with JSON its result schema reads back', () => {
    const server = stubFhirRecords({
      'Observation?': Effect.succeed(searchBundleOf([observation('o1', 'p1')], { total: 7 })),
    })

    const { content } = runCall(toolsFor(ada), server, 'search_records', {
      resourceType: 'Observation',
      params: [],
    })

    expect(Schema.decodeUnknownSync(Tools.PageResult)(content)).toEqual({
      resources: [observation('o1', 'p1')],
      total: 7,
      more: false,
    })
  })

  it('should refuse a parameter that would reach other patients, reading nothing', () => {
    const server = stubFhirRecords({ '': Effect.succeed(searchBundleOf([])) })

    const result = runCall(toolsFor(ada), server, 'search_records', {
      resourceType: 'Observation',
      params: [{ name: 'subject', value: 'Patient/p2' }],
    })

    expect(result).toEqual(
      failed(
        "The subject parameter isn't allowed: this chat is about one patient, and the tool sets whose records to search itself."
      )
    )
    expect(server.readPaths).toEqual([])
  })

  it('should refuse _revinclude on a type nothing pins, reading nothing', () => {
    const server = stubFhirRecords({ '': Effect.succeed(searchBundleOf([])) })

    const result = runCall(toolsFor(ada), server, 'search_records', {
      resourceType: 'Practitioner',
      params: [{ name: '_revinclude', value: 'Appointment:practitioner' }],
    })

    expect(result.is_error).toBe(true)
    expect(server.readPaths).toEqual([])
  })

  it('should refuse a page too large to send, saying how to narrow it', () => {
    const document = {
      resourceType: 'DocumentReference',
      id: 'd1',
      content: [{ attachment: { data: 'A'.repeat(500_000) } }],
    }
    const server = stubFhirRecords({
      'DocumentReference?': Effect.succeed(searchBundleOf([document])),
    })

    const result = runCall(toolsFor(everyone), server, 'search_records', {
      resourceType: 'DocumentReference',
      params: [],
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('too large')
  })

  it("should refuse a page holding another patient's records", () => {
    const server = stubFhirRecords({
      'Observation?': Effect.succeed(
        searchBundleOf([observation('o1', 'p1'), observation('o2', 'p2')])
      ),
    })

    const result = runCall(toolsFor(ada), server, 'search_records', {
      resourceType: 'Observation',
      params: [],
    })

    expect(result.is_error).toBe(true)
    expect(JSON.stringify(result)).not.toContain('o2')
  })

  it('should refuse a type the grant does not cover, and an input with extra properties', () => {
    const server = stubFhirRecords({})
    const tools = toolsFor(everyone, accessOf('patient/Observation.rs'))

    expect(
      runCall(tools, server, 'search_records', { resourceType: 'Condition', params: [] })
    ).toEqual(failed("Condition isn't one of the record types this tool can reach."))
    expect(
      runCall(tools, server, 'search_records', {
        resourceType: 'Observation',
        params: [],
        patient: 'p2',
      })
    ).toEqual(failed("The input doesn't match the tool's input schema."))
    expect(server.readPaths).toEqual([])
  })

  it("should fail with the server's OperationOutcome text", () => {
    const server = stubFhirRecords({
      'Observation?': fhirFailure(400, 'Unknown search parameter "colour"'),
    })

    expect(
      runCall(toolsFor(everyone), server, 'search_records', {
        resourceType: 'Observation',
        params: [{ name: 'colour', value: 'red' }],
      })
    ).toEqual(failed('The FHIR server answered 400. It said: Unknown search parameter "colour"'))
  })
  it.each([
    [{ kind: 'unreachable' } as const, "The FHIR server couldn't be reached."],
    [{ kind: 'not-json' } as const, "The FHIR server's answer wasn't JSON."],
  ])('should say why a read failed: %j', (failure, text) => {
    const server = stubFhirRecords({ 'Patient/p1': Effect.fail(new FhirReadFailed({ failure })) })

    expect(
      runCall(toolsFor(everyone), server, 'read_record', { resourceType: 'Patient', id: 'p1' })
    ).toEqual(failed(text))
  })
})
