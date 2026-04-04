import { Either, Schema } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { InstanceConfig, defaultConfig } from './config.ts'

describe('InstanceConfig', () => {
  it('should decode defaultConfig without error', () => {
    const result = Schema.decodeUnknownEither(InstanceConfig)(defaultConfig)
    expect(Either.isRight(result)).toBe(true)
  })

  it('should round-trip any rootUrl and patientId', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (rootUrl, patientId) => {
          const config = { _tag: 'fhir-r4', rootUrl, patientId } as const
          const encoded = Schema.encodeSync(InstanceConfig)(config)
          const decoded = Schema.decodeSync(InstanceConfig)(encoded)
          expect(decoded).toEqual(config)
        }
      )
    )
  })

  it('should reject missing rootUrl', () => {
    const result = Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'fhir-r4', patientId: '123' })
    expect(Either.isLeft(result)).toBe(true)
  })

  it('should reject missing patientId', () => {
    const result = Schema.decodeUnknownEither(InstanceConfig)({
      _tag: 'fhir-r4',
      rootUrl: 'https://example.com',
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe('defaultConfig', () => {
  it('should point to the SMART Health IT sandbox', () => {
    expect(defaultConfig.rootUrl).toBe('https://r2.smarthealthit.org')
    expect(defaultConfig.patientId).toBe('smart-1482713')
  })
})
