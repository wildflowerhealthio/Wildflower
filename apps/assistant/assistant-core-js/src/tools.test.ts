import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Scope } from '@wildflowerhealthio/scopes-core'
import { Effect, Encoding, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import type * as ChatPatient from './chat-patient.ts'
import { FhirReadFailed } from './fhir-records.ts'
import * as RecordAccess from './record-access.ts'
import {
  fhirFailure,
  searchBundleOf,
  STUB_FHIR_BASE,
  type StubFhirRecords,
  stubFhirRecords,
} from './test-helpers.ts'
import * as Tools from './tools.ts'

const ada: ChatPatient.Type = {
  kind: 'patient',
  patientId: 'p1',
  name: 'Ada Lovelace',
  birthDate: Option.none(),
}
const everyone: ChatPatient.Type = { kind: 'all-patients' }

const accessOf = (...scopes: readonly string[]): RecordAccess.Type =>
  RecordAccess.fromGrantedScopes(scopes.map(Scope.parse))
const everything = accessOf('system/*.cruds')

const toolsFor = (patient: ChatPatient.Type, access = everything): Tools.Type =>
  Tools.make({ access, patient })

const namesOf = (tools: Tools.Type): readonly string[] => tools.definitions.map(({ name }) => name)

/** Run the call `name` with `input` against `server`, as call `call-1`. */
const runCall = (
  tools: Tools.Type,
  server: StubFhirRecords,
  name: string,
  input: unknown
): BetaToolResultBlockParam =>
  Effect.runSync(Tools.run(tools, { id: 'call-1', name, input }).pipe(Effect.provide(server.layer)))

const succeeded = (content: unknown): BetaToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: 'call-1',
  content: JSON.stringify(content),
})

const failed = (content: string): BetaToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: 'call-1',
  is_error: true,
  content,
})

const observation = (id: string, patientId: string): unknown => ({
  resourceType: 'Observation',
  id,
  subject: { reference: `Patient/${patientId}` },
})

describe('Tools.make', () => {
  it('should offer every tool over every R4 type for every patient under system/*.cruds', () => {
    const tools = toolsFor(everyone)

    expect(namesOf(tools)).toEqual(['search_records', 'next_page', 'capabilities', 'read_record'])
    expect(tools.searchableTypes).toEqual(ResourceType.VALUES)
    expect(tools.readableTypes).toEqual(ResourceType.VALUES)
  })

  it('should offer fewer tools and types under a narrower grant', () => {
    expect(namesOf(toolsFor(everyone, accessOf('patient/Observation.r')))).toEqual(['read_record'])
    expect(toolsFor(everyone, accessOf('patient/Observation.rs')).searchableTypes).toEqual([
      'Observation',
    ])
    expect(namesOf(toolsFor(everyone, accessOf('patient/Observation.s')))).toEqual([
      'search_records',
      'next_page',
      'capabilities',
    ])
    expect(namesOf(toolsFor(everyone, accessOf('openid', 'patient/*.cu')))).toEqual([])
  })

  it('should offer only the types it can keep to one patient in a chat about one', () => {
    const tools = toolsFor(ada)

    expect(tools.searchableTypes).toContain('Observation')
    expect(tools.searchableTypes).toContain('Patient')
    expect(tools.searchableTypes).toContain('Practitioner')
    expect(tools.searchableTypes).not.toContain('Group')
    expect(tools.searchableTypes).not.toContain('Schedule')
    expect(tools.searchableTypes.length).toBeLessThan(ResourceType.VALUES.length)
  })

  it('should define strict tools whose objects allow no other properties', () => {
    const tools = toolsFor(ada, accessOf('patient/Observation.rs'))
    const withoutDescriptions: unknown = JSON.parse(
      JSON.stringify(tools.definitions, (key, value: unknown) =>
        key === 'description' ? undefined : value
      )
    )

    expect(tools.definitions[0]?.description).toContain('keeps every search to their records')
    expect(tools.definitions[3]?.description).toContain('about another patient')
    expect(withoutDescriptions).toEqual([
      {
        name: 'search_records',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            resourceType: {
              type: 'string',
              enum: ['Observation'],
            },
            params: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['name', 'value'],
                additionalProperties: false,
              },
            },
          },
          required: ['resourceType', 'params'],
          additionalProperties: false,
        },
      },
      {
        name: 'next_page',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { cursor: { type: 'string' } },
          required: ['cursor'],
          additionalProperties: false,
        },
      },
      {
        name: 'capabilities',
        strict: true,
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      {
        name: 'read_record',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            resourceType: {
              type: 'string',
              enum: ['Observation'],
            },
            id: { type: 'string' },
          },
          required: ['resourceType', 'id'],
          additionalProperties: false,
        },
      },
    ])
  })
})

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

describe('Tools.run next_page', () => {
  const nextUrl = `${STUB_FHIR_BASE}/Observation?patient=p1&_count=20&page=2`

  it("should give a cursor for the next page that reads the server's next link", () => {
    const server = stubFhirRecords({
      'Observation?patient=p1&_count=20&page=2': Effect.succeed(
        searchBundleOf([observation('o3', 'p1')])
      ),
      'Observation?': Effect.succeed(searchBundleOf([observation('o1', 'p1')], { nextUrl })),
    })
    const tools = toolsFor(ada)

    const first = runCall(tools, server, 'search_records', {
      resourceType: 'Observation',
      params: [],
    })
    const cursor = Encoding.encodeBase64Url('Observation?patient=p1&_count=20&page=2')
    const second = runCall(tools, server, 'next_page', { cursor })

    expect(first).toEqual(
      succeeded({ resources: [observation('o1', 'p1')], more: true, next: cursor })
    )
    expect(second).toEqual(succeeded({ resources: [observation('o3', 'p1')], more: false }))
  })

  it('should say there is more but give no cursor for a next link off the server', () => {
    const server = stubFhirRecords({
      'Observation?': Effect.succeed(
        searchBundleOf([], { nextUrl: 'https://elsewhere.example/Observation?page=2' })
      ),
    })

    expect(
      runCall(toolsFor(everyone), server, 'search_records', {
        resourceType: 'Observation',
        params: [],
      })
    ).toEqual(succeeded({ resources: [], more: true }))
  })

  it.each([
    ['https://elsewhere.example/Observation?page=2'],
    ['../admin/Observation'],
    ['Group?member=p2'],
  ])('should refuse a cursor for %s, reading nothing', (path) => {
    const server = stubFhirRecords({ '': Effect.succeed(searchBundleOf([])) })

    const result = runCall(toolsFor(ada), server, 'next_page', {
      cursor: Encoding.encodeBase64Url(path),
    })

    expect(result.is_error).toBe(true)
    expect(server.readPaths).toEqual([])
  })
})

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

describe('Tools.run capabilities', () => {
  it("should list the server's search parameters for the types the chat can search", () => {
    const server = stubFhirRecords({
      metadata: Effect.succeed({
        resourceType: 'CapabilityStatement',
        rest: [
          {
            resource: [
              { type: 'Observation', searchParam: [{ name: 'code' }, { name: 'date' }] },
              { type: 'Group', searchParam: [{ name: 'member' }] },
            ],
          },
        ],
      }),
    })

    expect(runCall(toolsFor(ada), server, 'capabilities', {})).toEqual(
      succeeded({ resourceTypes: [{ type: 'Observation', searchParams: ['code', 'date'] }] })
    )
  })
})

describe('Tools.run for a tool the chat lacks', () => {
  it('should fail the call, naming the tool', () => {
    expect(
      runCall(toolsFor(everyone, accessOf('openid')), stubFhirRecords({}), 'search_records', {})
    ).toEqual(failed('There is no tool called search_records.'))
  })
})
