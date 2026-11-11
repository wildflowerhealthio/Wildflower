import { describe, expect, it } from 'vite-plus/test'

import * as WriteProposal from './write-proposal.ts'

describe('WriteProposal.summaryOf', () => {
  it('should say what a create and an update would do', () => {
    expect(
      WriteProposal.summaryOf({
        kind: 'create',
        callId: 'c1',
        resource: { resourceType: 'Observation', status: 'final' },
      })
    ).toBe('Create Observation')
    expect(
      WriteProposal.summaryOf({
        kind: 'update',
        callId: 'c1',
        resource: { resourceType: 'MedicationRequest', id: '123' },
        versionId: '1',
        fields: [
          {
            path: ['status'],
            server: { _tag: 'value', value: 'active' },
            incoming: { _tag: 'value', value: 'stopped' },
          },
          { path: ['note'], server: { _tag: 'absent' }, incoming: { _tag: 'value', value: [] } },
        ],
      })
    ).toBe('Update MedicationRequest/123, 2 fields')
  })
})

describe('WriteProposal.fieldChangeOf', () => {
  it.each([
    [{ _tag: 'absent' }, { _tag: 'value', value: 1 }, 'added'],
    [{ _tag: 'value', value: 1 }, { _tag: 'value', value: 2 }, 'changed'],
    [{ _tag: 'value', value: 1 }, { _tag: 'absent' }, 'removed'],
  ] as const)('should read %j -> %j as %s', (server, incoming, change) => {
    expect(WriteProposal.fieldChangeOf({ path: ['x'], server, incoming })).toBe(change)
  })
})
