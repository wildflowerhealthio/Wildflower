import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { FhirWriteFailed } from '../../fhir-records.ts'
import { stubFhirRecords } from '../../test-helpers.ts'
import type * as WriteProposal from '../../write-proposal.ts'
import * as Tools from './index.ts'
import { failed, carryOutAgainst, weight, storedWeight } from './tools.test-helpers.ts'

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
