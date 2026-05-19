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

  it('accepts a fresh-install snapshot (booleans false, every nullable field null)', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(TunnelStateSchema)({
        subdomain: null,
        rootDomain: null,
        localPort: null,
        requestedEnabled: false,
        currentEnabled: false,
        currentSubdomain: null,
        currentRootDomain: null,
        currentLocalPort: null,
        error: null,
      }),
      {
        subdomain: null,
        rootDomain: null,
        localPort: null,
        requestedEnabled: false,
        currentEnabled: false,
        currentSubdomain: null,
        currentRootDomain: null,
        currentLocalPort: null,
        error: null,
      }
    )
  })

  it('rejects state missing the required requestedEnabled flag', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(TunnelStateSchema)({ currentEnabled: false }),
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
        localPort: 8080,
        requestedEnabled: true,
      }),
      {
        subdomain: 'wildflower-expo-dev',
        rootDomain: 'loca.lt',
        localPort: 8080,
        requestedEnabled: true,
      }
    )
  })

  it('accepts a single-field patch (toggle requestedEnabled)', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(SetTunnelRequestBodySchema)({ requestedEnabled: true }),
      { requestedEnabled: true }
    )
  })

  it('accepts null config fields (explicit clear)', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(SetTunnelRequestBodySchema)({
        subdomain: null,
        rootDomain: null,
        localPort: null,
      }),
      { subdomain: null, rootDomain: null, localPort: null }
    )
  })

  it('accepts an empty body (no-op)', () => {
    expectRightToEqual(Schema.decodeUnknownEither(SetTunnelRequestBodySchema)({}), {})
  })
})
