import { Effect, Either } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { stubFhirRecords } from '../../test-helpers.ts'
import * as Tools from './index.ts'
import {
  ada,
  toolsFor,
  failed,
  chatHavingRead,
  proposeCall,
  storedWeight,
} from './tools.test-helpers.ts'

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

  it('should not read a change given without meta as removing it', () => {
    const server = stubFhirRecords({ 'Observation/o1': Effect.succeed(storedWeight) })
    const { meta: _meta, ...withoutMeta } = storedWeight

    expect(
      proposeCall(
        toolsFor(ada),
        server,
        'update_record',
        { ...withoutMeta, status: 'amended' },
        chatHavingRead(storedWeight)
      )
    ).toMatchObject(
      Either.right({
        fields: [
          {
            path: ['status'],
            server: { _tag: 'value', value: 'final' },
            incoming: { _tag: 'value', value: 'amended' },
          },
        ],
      })
    )
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
