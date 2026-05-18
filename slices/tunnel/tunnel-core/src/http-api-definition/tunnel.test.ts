import { Arbitrary, Schema } from 'effect'
import fc from 'fast-check'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { SetTunnelRequestBodySchema, TunnelStateSchema } from './tunnel.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('TunnelStateSchema', () => {
  it('round-trips any schema-conformant state', () => {
    fc.assert(
      fc.property(Arbitrary.make(TunnelStateSchema), (state) => {
        const encoded = Schema.encodeSync(TunnelStateSchema)(state)
        expect(Schema.decodeSync(TunnelStateSchema)(encoded)).toEqual(state)
      })
    )
  })

  it('accepts a minimal state (just running)', () => {
    expectRightToEqual(Schema.decodeUnknownEither(TunnelStateSchema)({ running: false }), {
      running: false,
    })
  })

  it('rejects state missing the required running flag', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(TunnelStateSchema)({
        currentPublicOrigin: 'https://tunnel.example.com',
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('SetTunnelRequestBodySchema', () => {
  it('accepts a string requestedPublicOrigin', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(SetTunnelRequestBodySchema)({
        requestedPublicOrigin: 'https://tunnel.example.com',
      }),
      { requestedPublicOrigin: 'https://tunnel.example.com' }
    )
  })

  it('accepts null requestedPublicOrigin (clear)', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(SetTunnelRequestBodySchema)({
        requestedPublicOrigin: null,
      }),
      { requestedPublicOrigin: null }
    )
  })

  it('rejects a missing requestedPublicOrigin key', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(SetTunnelRequestBodySchema)({}),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})
