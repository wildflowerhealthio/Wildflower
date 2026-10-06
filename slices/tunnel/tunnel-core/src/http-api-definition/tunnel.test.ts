import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { freshTunnelState as FRESH_STATE, httpApiGroup, TunnelStateViewSchema } from './tunnel.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('TunnelStateViewSchema', () => {
  it('round-trips any schema-conformant state', () => {
    fc.assert(
      fc.property(Arbitrary.make(TunnelStateViewSchema), (state) => {
        const encoded = Schema.encodeSync(TunnelStateViewSchema)(state)
        expect(Schema.decodeSync(TunnelStateViewSchema)(encoded)).toEqual(state)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('accepts a just-started snapshot', () => {
    expectRightToEqual(Schema.decodeUnknownEither(TunnelStateViewSchema)(FRESH_STATE), FRESH_STATE)
  })

  it('accepts an unreachable snapshot with its error', () => {
    const unreachable = { status: 'unreachable' as const, error: 'relay unreachable' }
    expectRightToEqual(Schema.decodeUnknownEither(TunnelStateViewSchema)(unreachable), unreachable)
  })

  it('rejects state missing the error', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(TunnelStateViewSchema)({ status: 'dialing' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('httpApiGroup', () => {
  it('reads the tunnel and has no endpoint that writes it', () => {
    expect(Object.values(httpApiGroup.endpoints).map((endpoint) => endpoint.method)).toEqual([
      'GET',
    ])
  })
})
