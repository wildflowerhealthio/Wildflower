import { Arbitrary, Schema } from 'effect'
import fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { SetTunnelRequestBodySchema, TunnelStateSchema } from './tunnel.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('TunnelStateSchema', () => {
  it('round-trips any schema-conformant state', () => {
    fc.assert(
      fc.property(Arbitrary.make(TunnelStateSchema), (state) => {
        const encoded = Schema.encodeSync(TunnelStateSchema)(state)
        expect(Schema.decodeSync(TunnelStateSchema)(encoded)).toEqual(state)
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  it('accepts a fresh-install snapshot (booleans false, every nullable field null)', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(TunnelStateSchema)({
        subdomain: null,
        rootDomain: null,
        requestedRunning: false,
        running: false,
        currentSubdomain: null,
        currentRootDomain: null,
        currentLocalPort: null,
        error: null,
        servedOrigin: 'http://127.0.0.1:8080',
      }),
      {
        subdomain: null,
        rootDomain: null,
        requestedRunning: false,
        running: false,
        currentSubdomain: null,
        currentRootDomain: null,
        currentLocalPort: null,
        error: null,
        servedOrigin: 'http://127.0.0.1:8080',
      }
    )
  })

  it('rejects state missing the required requestedRunning flag', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(TunnelStateSchema)({ running: false }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('SetTunnelRequestBodySchema', () => {
  it('accepts a full config patch', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(SetTunnelRequestBodySchema)({
        subdomain: 'wildflower-expo-dev',
        rootDomain: 'loca.lt',
        requestedRunning: true,
      }),
      {
        subdomain: 'wildflower-expo-dev',
        rootDomain: 'loca.lt',
        requestedRunning: true,
      }
    )
  })

  it('accepts a single-field patch (toggle requestedRunning)', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(SetTunnelRequestBodySchema)({ requestedRunning: true }),
      { requestedRunning: true }
    )
  })

  it('accepts null config fields (explicit clear)', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(SetTunnelRequestBodySchema)({
        subdomain: null,
        rootDomain: null,
      }),
      { subdomain: null, rootDomain: null }
    )
  })

  it('accepts an empty body (no-op)', () => {
    expectRightToEqual(Schema.decodeUnknownEither(SetTunnelRequestBodySchema)({}), {})
  })
})
