import { Arbitrary, Schema } from 'effect'
import fc from 'fast-check'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { ServerStateSchema, SetTunnelBodySchema, TunnelUnavailableSchema } from './server.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('ServerStateSchema', () => {
  it('round-trips any schema-conformant state', () => {
    fc.assert(
      fc.property(Arbitrary.make(ServerStateSchema), (state) => {
        const encoded = Schema.encodeSync(ServerStateSchema)(state)
        expect(Schema.decodeSync(ServerStateSchema)(encoded)).toEqual(state)
      })
    )
  })

  it('rejects state missing port', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(ServerStateSchema)({
        origin: 'http://localhost',
        localOrigin: 'http://localhost',
        tunnelActive: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('SetTunnelBodySchema', () => {
  it.each([true, false])('accepts tunnelActive=%s', (tunnelActive) => {
    expectRightToEqual(Schema.decodeUnknownEither(SetTunnelBodySchema)({ tunnelActive }), {
      tunnelActive,
    })
  })

  it('rejects non-boolean tunnelActive', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(SetTunnelBodySchema)({ tunnelActive: 'yes' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('TunnelUnavailableSchema', () => {
  it('accepts the declared error payload', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(TunnelUnavailableSchema)({
        error: 'TunnelUnavailable',
        reason: 'Node host has no tunnel.',
      }),
      { error: 'TunnelUnavailable', reason: 'Node host has no tunnel.' }
    )
  })
})
