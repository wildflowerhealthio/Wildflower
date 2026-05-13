import { Arbitrary, Schema } from 'effect'
import fc from 'fast-check'
import {
  InstanceConfig as FhirR4InstanceConfig,
  remoteKind as fhirR4ClientKind,
} from 'fhir-r4-client-collector'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { CollectorConfig, CollectorTag, makeRemoteForConfig } from './registry.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('CollectorTag', () => {
  it('accepts the fhir-r4 literal', () => {
    expectRightToEqual(Schema.decodeUnknownEither(CollectorTag)('fhir-r4'), 'fhir-r4')
  })

  it('rejects unsupported tags', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CollectorTag)('unsupported-collector'),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('CollectorConfig', () => {
  it('decodes a valid fhir-r4 config', () => {
    const config = Schema.decodeSync(FhirR4InstanceConfig)({
      _tag: 'fhir-r4',
      rootUrl: 'https://example.com',
      patientId: '12345',
    })

    expectRightToEqual(Schema.decodeUnknownEither(CollectorConfig)(config), config)
  })

  it('round-trips any schema-conformant config', () => {
    fc.assert(
      fc.property(Arbitrary.make(CollectorConfig), (config) => {
        const encoded = Schema.encodeSync(CollectorConfig)(config)
        expect(Schema.decodeSync(CollectorConfig)(encoded)).toEqual(config)
      })
    )
  })

  it('rejects unknown collector tags', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CollectorConfig)({
        _tag: 'unknown-collector',
        rootUrl: 'https://example.com',
        patientId: '12345',
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('makeRemoteForConfig', () => {
  it('dispatches fhir-r4 configs to the fhir-r4 remote kind', () => {
    const config = Schema.decodeSync(CollectorConfig)({
      _tag: 'fhir-r4',
      rootUrl: 'https://example.com',
      patientId: '12345',
    })

    expect(makeRemoteForConfig(config)).toBe(fhirR4ClientKind)
  })
})
