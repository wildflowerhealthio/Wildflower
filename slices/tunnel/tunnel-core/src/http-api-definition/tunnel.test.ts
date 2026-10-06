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

  it('accepts a verified snapshot served at the public origin', () => {
    const verified = {
      publicHost: 'my-clinic.example.com',
      status: 'verified' as const,
      running: true,
      error: null,
      dialAttempts: 2,
      servedOrigin: 'https://my-clinic.example.com',
    }
    expectRightToEqual(Schema.decodeUnknownEither(TunnelStateViewSchema)(verified), verified)
  })

  it('drops the relay settings and run intent the server no longer sends', () => {
    // The relay settings live in the server's record, which only the base reads.
    const decoded = Schema.decodeUnknownSync(TunnelStateViewSchema)({
      ...FRESH_STATE,
      settingsRevision: 3,
      requestedRunning: true,
      relay: { remoteAddr: 'relay.example.com:2333', publicKey: 'key', serviceName: 'ruth' },
    })
    expect(decoded).toEqual(FRESH_STATE)
  })

  it('rejects state missing the public host', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(TunnelStateViewSchema)({ ...FRESH_STATE, publicHost: null }),
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
