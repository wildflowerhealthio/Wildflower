import { Arbitrary, Schema } from 'effect'
import fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  CreateRemotePayloadSchema,
  RemoteNotFoundSchema,
  UpdateRemotePayloadSchema,
} from './remotes.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('CreateRemotePayloadSchema', () => {
  it('round-trips any schema-conformant payload', () => {
    fc.assert(
      fc.property(Arbitrary.make(CreateRemotePayloadSchema), (payload) => {
        const encoded = Schema.encodeSync(CreateRemotePayloadSchema)(payload)
        expect(Schema.decodeSync(CreateRemotePayloadSchema)(encoded)).toEqual(payload)
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  it('rejects payloads without id', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CreateRemotePayloadSchema)({
        name: 'Sandbox',
        config: {
          _tag: 'fhir-r4',
          rootUrl: 'https://example.com',
          patientId: '12345',
        },
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('UpdateRemotePayloadSchema', () => {
  it('round-trips any schema-conformant payload', () => {
    fc.assert(
      fc.property(Arbitrary.make(UpdateRemotePayloadSchema), (payload) => {
        const encoded = Schema.encodeSync(UpdateRemotePayloadSchema)(payload)
        expect(Schema.decodeSync(UpdateRemotePayloadSchema)(encoded)).toEqual(payload)
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  it('rejects payloads without name', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(UpdateRemotePayloadSchema)({
        config: {
          _tag: 'fhir-r4',
          rootUrl: 'https://example.com',
          patientId: '12345',
        },
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('RemoteNotFoundSchema', () => {
  it('accepts the declared error payload', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(RemoteNotFoundSchema)({
        error: 'RemoteNotFound',
        id: 'missing-remote',
      }),
      { error: 'RemoteNotFound', id: 'missing-remote' }
    )
  })

  it('rejects any error literal besides RemoteNotFound', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(RemoteNotFoundSchema)({
        error: 'UnknownError',
        id: 'missing-remote',
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})
