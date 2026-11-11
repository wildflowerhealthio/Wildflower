import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { stubFhirRecords } from '../../test-helpers.ts'
import { ada, toolsFor, runCall, succeeded } from './tools.test-helpers.ts'

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
