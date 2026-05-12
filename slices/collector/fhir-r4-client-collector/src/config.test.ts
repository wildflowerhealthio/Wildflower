import { Schema } from 'effect'
import fc from 'fast-check'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { InstanceConfig, defaultConfig } from './config.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

describe('InstanceConfig', () => {
  it('decodes defaultConfig without error', () => {
    expectRightToEqual(Schema.decodeUnknownEither(InstanceConfig)(defaultConfig), defaultConfig)
  })

  it('round-trips any rootUrl and patientId', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (rootUrl, patientId) => {
          const config = { _tag: 'fhir-r4', rootUrl, patientId } as const
          const encoded = Schema.encodeSync(InstanceConfig)(config)
          expect(Schema.decodeSync(InstanceConfig)(encoded)).toEqual(config)
        }
      )
    )
  })

  it('rejects missing rootUrl', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'fhir-r4', patientId: '123' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects missing patientId', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({
        _tag: 'fhir-r4',
        rootUrl: 'https://example.com',
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('defaultConfig', () => {
  it('points to the SMART Health IT sandbox', () => {
    expect(defaultConfig).toMatchObject({
      rootUrl: 'https://r4.smarthealthit.org',
      patientId: '8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882',
    })
  })
})
