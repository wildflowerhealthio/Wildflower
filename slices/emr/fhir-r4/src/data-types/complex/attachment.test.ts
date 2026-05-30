import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Attachment as StoreAttachment } from 'emr-core/schemas'

import * as Attachment from './attachment.ts'

describe('FhirR4Attachment', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreAttachment.Schema), (attachment) => {
        const fhir = Schema.encodeSync(Attachment.Schema)(attachment)
        const decoded = Schema.decodeSync(Attachment.Schema)(fhir)
        expect(decoded).toSchemaEqual(StoreAttachment.Schema, attachment)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
