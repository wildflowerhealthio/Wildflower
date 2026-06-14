import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { InstanceConfig, defaultConfig } from './config.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

describe('InstanceConfig', () => {
  it('decodes defaultConfig without error', () => {
    expectRightToEqual(Schema.decodeUnknownEither(InstanceConfig)(defaultConfig), defaultConfig)
  })

  it('round-trips any schema-conformant rootUrl and patientId', () => {
    // Derive the arbitrary from the schema itself so the property test
    // stays in lockstep with the validation pattern — when the schema
    // tightens, the arbitrary narrows automatically.
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const encoded = Schema.encodeSync(InstanceConfig)(config)
        expect(Schema.decodeSync(InstanceConfig)(encoded)).toEqual(config)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
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

  it.each([
    'javascript:alert(1)',
    'http://',
    'https://r4.smarthealthit.org/',
    'r4.smarthealthit.org',
    'https://example.com?query=1',
    'https://example.com#frag',
    '',
  ])('rejects rootUrl %s', (rootUrl) => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'fhir-r4', rootUrl, patientId: 'abc' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it.each(['', 'a/b', 'a?b', 'a&b', 'has space', 'a'.repeat(65)])(
    'rejects patientId %s',
    (patientId) => {
      expectLeftToEqual(
        Schema.decodeUnknownEither(InstanceConfig)({
          _tag: 'fhir-r4',
          rootUrl: 'https://example.com',
          patientId,
        }),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    }
  )
})

describe('defaultConfig', () => {
  it('points to the SMART Health IT sandbox', () => {
    expect(defaultConfig).toMatchObject({
      rootUrl: 'https://r4.smarthealthit.org',
      patientId: '8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882',
    })
  })
})
