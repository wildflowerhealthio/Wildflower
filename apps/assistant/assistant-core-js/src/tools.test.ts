import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Scope } from '@wildflowerhealthio/scopes-core'
import { Effect, Either, Encoding, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import type * as ChatPatient from './chat-patient.ts'
import * as Chat from './chat.ts'
import { FhirReadFailed, FhirWriteFailed } from './fhir-records.ts'
import * as RecordAccess from './record-access.ts'
import {
  fhirFailure,
  onePatientChat,
  searchBundleOf,
  STUB_FHIR_BASE,
  type StubFhirRecords,
  stubFhirRecords,
  toolUseBlock,
} from './test-helpers.ts'
import * as Tools from './tools.ts'
import type * as WriteProposal from './write-proposal.ts'

const ada = onePatientChat({ id: 'p1', given: 'Ada', family: 'Lovelace' })
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
  it('should offer every tool over every R4 type for every patient under system/*.cruds, and none that deletes', () => {
    const tools = toolsFor(everyone)

    expect(namesOf(tools)).toEqual([
      'search_records',
      'next_page',
      'capabilities',
      'read_record',
      'create_record',
      'update_record',
    ])
    expect(tools.searchableTypes).toEqual(ResourceType.VALUES)
    expect(tools.readableTypes).toEqual(ResourceType.VALUES)
    expect(tools.creatableTypes).toEqual(ResourceType.VALUES)
    expect(tools.updatableTypes).toEqual(ResourceType.VALUES)
  })

  it('should offer no delete tool under any grant', () => {
    for (const scope of ['system/*.cruds', 'system/*.d', 'user/Observation.cruds', 'patient/*.*']) {
      expect(
        namesOf(toolsFor(everyone, accessOf(scope))).filter((name) => /delete/u.test(name))
      ).toEqual([])
    }
    expect(namesOf(toolsFor(everyone, accessOf('system/*.d')))).toEqual([])
  })

  it('should offer the write tools only for the types the grant can create or update', () => {
    const tools = toolsFor(everyone, accessOf('patient/Observation.c', 'patient/Condition.u'))

    expect(namesOf(tools)).toEqual(['create_record', 'update_record'])
    expect(tools.creatableTypes).toEqual(['Observation'])
    expect(tools.updatableTypes).toEqual(['Condition'])
    expect(tools.definitions[0]).toMatchObject({
      input_schema: {
        properties: {
          resource: { properties: { resourceType: { enum: ['Observation'] } } },
        },
      },
    })
  })

  it('should not offer to create a Patient in a chat about one, but should to update theirs', () => {
    expect(toolsFor(ada).creatableTypes).not.toContain('Patient')
    expect(toolsFor(ada).creatableTypes).toContain('Observation')
    expect(toolsFor(ada).updatableTypes).toContain('Patient')
    expect(toolsFor(everyone).creatableTypes).toContain('Patient')
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
    expect(namesOf(toolsFor(everyone, accessOf('openid', 'patient/*.d')))).toEqual([])
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

/** A chat in which `read_record` read each of `records`, one round each. */
const chatHavingRead = (...records: readonly unknown[]): Chat.Type =>
  records.reduce<Chat.Type>(
    (chat, record, index) =>
      Chat.append(chat, {
        _tag: 'tool-round',
        modelId: 'claude-sonnet-5',
        message: {
          role: 'assistant',
          content: [toolUseBlock(`read-${String(index)}`, 'read_record', {})],
        },
        results: [
          {
            type: 'tool_result',
            tool_use_id: `read-${String(index)}`,
            content: JSON.stringify(record),
          },
        ],
      }),
    Chat.append(Chat.start('telehealth'), Chat.questionOf('Fix my record'))
  )

/** Propose the write `name` with `resource` against `server`, as call `call-1`, after `chat`. */
const proposeCall = (
  tools: Tools.Type,
  server: StubFhirRecords,
  name: string,
  resource: unknown,
  chat: Chat.Type = chatHavingRead()
): Either.Either<WriteProposal.Type, BetaToolResultBlockParam> =>
  Effect.runSync(
    Tools.propose(
      tools,
      { id: 'call-1', name, input: { resource } },
      Tools.versionsReadIn(chat)
    ).pipe(Effect.provide(server.layer))
  )

/** Carry out `proposal` as `decision` against `server`. */
const carryOutAgainst = (
  server: StubFhirRecords,
  proposal: WriteProposal.Type,
  decision: WriteProposal.Decision
): Promise<BetaToolResultBlockParam> =>
  Effect.runPromise(Tools.carryOut(proposal, decision).pipe(Effect.provide(server.layer)))

const weight = {
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'Weight' },
  valueQuantity: { value: 70, unit: 'kg' },
}

const storedWeight = {
  ...weight,
  id: 'o1',
  subject: { reference: 'Patient/p1' },
  meta: { versionId: '3', lastUpdated: '2026-11-01T00:00:00Z' },
}

describe('Tools.propose create_record', () => {
  it("should propose the record with its subject pointed at the chat's patient", () => {
    const proposal = proposeCall(toolsFor(ada), stubFhirRecords({}), 'create_record', {
      ...weight,
      subject: { reference: 'Patient/p1', display: 'Ada' },
    })

    expect(proposal).toEqual(
      Either.right({
        kind: 'create',
        callId: 'call-1',
        resource: { ...weight, subject: { reference: 'Patient/p1', display: 'Ada' } },
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

  it('should refuse a type the grant cannot create', () => {
    const tools = toolsFor(everyone, accessOf('patient/Condition.c'))

    expect(proposeCall(tools, stubFhirRecords({}), 'create_record', weight)).toEqual(
      Either.left(failed("Observation isn't one of the record types this tool can reach."))
    )
  })
})

describe('Tools.propose update_record', () => {
  const amended = {
    ...storedWeight,
    status: 'amended',
    valueQuantity: { value: 71 },
    note: [{ text: 'Rechecked' }],
  }

  it('should refuse an update of a record not read in this chat', () => {
    const server = stubFhirRecords({ 'Observation/o1': Effect.succeed(storedWeight) })

    expect(proposeCall(toolsFor(ada), server, 'update_record', amended)).toEqual(
      Either.left(
        failed(
          "Observation/o1 hasn't been read in this chat, so the version to change isn't known. Read it with read_record first."
        )
      )
    )
    expect(server.readPaths).toEqual([])
  })

  it('should read the record again and propose the change field by field: added, changed and removed', () => {
    const server = stubFhirRecords({ 'Observation/o1': Effect.succeed(storedWeight) })

    const proposal = proposeCall(
      toolsFor(ada),
      server,
      'update_record',
      amended,
      chatHavingRead(storedWeight)
    )

    expect(proposal).toEqual(
      Either.right({
        kind: 'update',
        callId: 'call-1',
        resource: amended,
        versionId: '3',
        fields: [
          {
            path: ['status'],
            server: { _tag: 'value', value: 'final' },
            incoming: { _tag: 'value', value: 'amended' },
          },
          {
            path: ['valueQuantity', 'value'],
            server: { _tag: 'value', value: 70 },
            incoming: { _tag: 'value', value: 71 },
          },
          {
            path: ['valueQuantity', 'unit'],
            server: { _tag: 'value', value: 'kg' },
            incoming: { _tag: 'absent' },
          },
          {
            path: ['note'],
            server: { _tag: 'absent' },
            incoming: { _tag: 'value', value: [{ text: 'Rechecked' }] },
          },
        ],
      })
    )
    expect(server.readPaths).toEqual(['Observation/o1'])
  })

  it('should refuse an update when the record changed since it was read', () => {
    const server = stubFhirRecords({
      'Observation/o1': Effect.succeed({ ...storedWeight, meta: { versionId: '4' } }),
    })

    expect(
      proposeCall(toolsFor(ada), server, 'update_record', amended, chatHavingRead(storedWeight))
    ).toEqual(Either.left(failed(Tools.STALE_RECORD_TEXT)))
  })

  it('should propose against the latest version the chat read', () => {
    const server = stubFhirRecords({
      'Observation/o1': Effect.succeed({ ...storedWeight, meta: { versionId: '4' } }),
    })
    const chat = chatHavingRead(storedWeight, { ...storedWeight, meta: { versionId: '4' } })

    expect(proposeCall(toolsFor(ada), server, 'update_record', amended, chat)).toMatchObject(
      Either.right({ versionId: '4' })
    )
  })

  it('should refuse a change that would move the record to another patient', () => {
    const server = stubFhirRecords({ 'Observation/o1': Effect.succeed(storedWeight) })

    expect(
      proposeCall(
        toolsFor(ada),
        server,
        'update_record',
        { ...amended, subject: { reference: 'Patient/p2' } },
        chatHavingRead(storedWeight)
      )
    ).toEqual(
      Either.left(
        failed(
          "This change would make the record about another patient, so it isn't proposed: this chat is about one patient."
        )
      )
    )
  })

  it("should change only the chat's own Patient in a chat about one", () => {
    const bob = { resourceType: 'Patient', id: 'p2', meta: { versionId: '1' } }
    const ada1 = { resourceType: 'Patient', id: 'p1', meta: { versionId: '1' } }
    const server = stubFhirRecords({
      'Patient/p1': Effect.succeed(ada1),
      'Patient/p2': Effect.succeed(bob),
    })
    const chat = chatHavingRead(ada1, bob)

    expect(
      proposeCall(toolsFor(ada), server, 'update_record', { ...bob, gender: 'male' }, chat)
    ).toEqual(
      Either.left(
        failed(
          "This change would make the record about another patient, so it isn't proposed: this chat is about one patient."
        )
      )
    )
    expect(
      proposeCall(toolsFor(ada), server, 'update_record', { ...ada1, gender: 'female' }, chat)
    ).toMatchObject(Either.right({ kind: 'update', versionId: '1' }))
  })

  it('should refuse a change that changes nothing', () => {
    const server = stubFhirRecords({ 'Observation/o1': Effect.succeed(storedWeight) })

    expect(
      proposeCall(
        toolsFor(ada),
        server,
        'update_record',
        storedWeight,
        chatHavingRead(storedWeight)
      )
    ).toEqual(Either.left(failed('The record already says this, so there is nothing to change.')))
  })
})

describe('Tools.versionsReadIn', () => {
  it('should hold the latest version of each record read, searched or written, and none from failed calls', () => {
    const searched = { ...storedWeight, id: 'o2', meta: { versionId: '7' } }
    const chat = Chat.append(chatHavingRead(storedWeight, { resourceType: 'Patient', id: 'p1' }), {
      _tag: 'tool-round',
      modelId: 'claude-sonnet-5',
      message: {
        role: 'assistant',
        content: [
          toolUseBlock('search', 'search_records', {}),
          toolUseBlock('update', 'update_record', {}),
          toolUseBlock('failed', 'read_record', {}),
        ],
      },
      results: [
        {
          type: 'tool_result',
          tool_use_id: 'search',
          content: JSON.stringify({ resources: [searched], more: false }),
        },
        {
          type: 'tool_result',
          tool_use_id: 'update',
          content: Schema.encodeSync(Tools.WriteRecordResult)({
            resourceType: 'Observation',
            id: 'o1',
            versionId: '4',
            record: { ...storedWeight, meta: { versionId: '4' } },
          }),
        },
        {
          type: 'tool_result',
          tool_use_id: 'failed',
          is_error: true,
          content: JSON.stringify({ ...storedWeight, id: 'o3' }),
        },
      ],
    })

    expect(Tools.versionsReadIn(chat)).toEqual(
      new Map([
        ['Observation/o1', '4'],
        ['Observation/o2', '7'],
      ])
    )
  })
})

describe('Tools.carryOut', () => {
  const createProposal: WriteProposal.Type = {
    kind: 'create',
    callId: 'call-1',
    resource: { ...weight, resourceType: 'Observation', subject: { reference: 'Patient/p1' } },
  }
  const updateProposal: WriteProposal.Type = {
    kind: 'update',
    callId: 'call-1',
    resource: { ...storedWeight, resourceType: 'Observation', status: 'amended' },
    versionId: '3',
    fields: [],
  }

  it('should create an approved record and answer with the stored record', async () => {
    const server = stubFhirRecords({})

    const result = await carryOutAgainst(server, createProposal, { kind: 'approved' })

    expect(server.writes).toEqual([{ kind: 'create', resource: createProposal.resource }])
    expect(result).toEqual({
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: Schema.encodeSync(Tools.WriteRecordResult)({
        resourceType: 'Observation',
        id: 'created-1',
        versionId: '1',
        record: { ...createProposal.resource, id: 'created-1', meta: { versionId: '1' } },
      }),
    })
  })

  it('should update an approved record against the version it was proposed at', async () => {
    const server = stubFhirRecords({})

    const result = await carryOutAgainst(server, updateProposal, { kind: 'approved' })

    expect(server.writes).toEqual([
      { kind: 'update', resource: updateProposal.resource, versionId: '3' },
    ])
    expect(Schema.decodeUnknownSync(Tools.WriteRecordResult)(result.content)).toMatchObject({
      id: 'o1',
      versionId: '4',
    })
  })

  it('should tell the agent to re-read a record that changed before the update landed', async () => {
    const server = stubFhirRecords(
      {},
      {
        answerWrite: () =>
          Effect.fail(new FhirWriteFailed({ failure: { kind: 'precondition-failed' } })),
      }
    )

    expect(await carryOutAgainst(server, updateProposal, { kind: 'approved' })).toEqual(
      failed('The record changed since you read it; re-read it first.')
    )
  })

  it("should pass on what the server's OperationOutcome said of a refused write", async () => {
    const server = stubFhirRecords(
      {},
      {
        answerWrite: () =>
          Effect.fail(
            new FhirWriteFailed({
              failure: {
                kind: 'error-status',
                status: 422,
                outcomeText: Option.some('code is required'),
              },
            })
          ),
      }
    )

    expect(await carryOutAgainst(server, createProposal, { kind: 'approved' })).toEqual(
      failed('The FHIR server answered 422, so nothing was saved. It said: code is required')
    )
  })

  it.each([
    [Option.none(), 'The user declined this change.'],
    [Option.some('Wrong date'), 'The user declined this change. Reason: Wrong date'],
  ])('should write nothing for a declined change and say so', async (reason, content) => {
    const server = stubFhirRecords({})

    expect(await carryOutAgainst(server, createProposal, { kind: 'declined', reason })).toEqual(
      failed(content)
    )
    expect(server.writes).toEqual([])
  })
})
