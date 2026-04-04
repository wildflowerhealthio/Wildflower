import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import { Attachment } from './attachment.ts'
import type { AttachmentEncoded } from './attachment.ts'

const attachmentArb = Arbitrary.make(Attachment)

describe('Attachment model', () => {
  test('Attachment.ResourceType is "Attachment"', () => {
    expect(Attachment.ResourceType).toBe('Attachment')
  })

  test('should encode to encoded type', () => {
    expectTypeOf<typeof Attachment.Encoded>().toExtend<AttachmentEncoded>()
  })
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(attachmentArb, (attachment) => {
        const encoded = Schema.encodeSync(Attachment)(attachment)
        const decoded = Schema.decodeSync(Attachment)(encoded)
        expect(decoded).toSchemaEqual(attachment)
      })
    )
  })
})
