import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Attachment from './attachment.ts'

const attachmentArb = Arbitrary.make(Attachment.Schema)

describe('Attachment model', () => {
  test('Attachment.ResourceType is "Attachment"', () => {
    expect(Attachment.ResourceType).toBe('Attachment')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(attachmentArb, (attachment) => {
        const encoded = Schema.encodeSync(Attachment.Schema)(attachment)
        const decoded = Schema.decodeSync(Attachment.Schema)(encoded)
        expect(decoded).toSchemaEqual(Attachment.Schema, attachment)
      }),
      { numRuns: numRunsFor(100) }
    )
  })
})
