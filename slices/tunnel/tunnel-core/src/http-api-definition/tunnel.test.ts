import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { RelayInputSchema, ReplaceTunnelRequestBodySchema, TunnelStateSchema } from './tunnel.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

// A fresh-install snapshot: every counter at zero, every nullable null,
// the server bound to its loopback fallback.
const FRESH_STATE = {
  revision: 0,
  publicHost: null,
  requestedRunning: false,
  running: false,
  error: null,
  attempt: 0,
  servedOrigin: 'http://127.0.0.1:8080',
}

describe('TunnelStateSchema', () => {
  it('round-trips any schema-conformant state', () => {
    fc.assert(
      fc.property(Arbitrary.make(TunnelStateSchema), (state) => {
        const encoded = Schema.encodeSync(TunnelStateSchema)(state)
        expect(Schema.decodeSync(TunnelStateSchema)(encoded)).toEqual(state)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('accepts a fresh-install snapshot', () => {
    expectRightToEqual(Schema.decodeUnknownEither(TunnelStateSchema)(FRESH_STATE), FRESH_STATE)
  })

  it('accepts a running snapshot with a public host and served origin', () => {
    const running = {
      revision: 7,
      publicHost: 'my-clinic.example.com',
      requestedRunning: true,
      running: true,
      error: null,
      attempt: 2,
      servedOrigin: 'https://my-clinic.example.com',
    }
    expectRightToEqual(Schema.decodeUnknownEither(TunnelStateSchema)(running), running)
  })

  it('decodes the 409 conflict body — same shape, just a newer revision', () => {
    // The PUT 409 carries the current snapshot via TunnelStateSchema, so a
    // bumped-revision body must decode like any other state.
    const conflict = { ...FRESH_STATE, revision: 42 }
    expectRightToEqual(Schema.decodeUnknownEither(TunnelStateSchema)(conflict), conflict)
  })

  it('rejects state missing the required requestedRunning flag', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(TunnelStateSchema)({
        ...FRESH_STATE,
        requestedRunning: undefined,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('RelayInputSchema', () => {
  it('round-trips any schema-conformant relay', () => {
    fc.assert(
      fc.property(Arbitrary.make(RelayInputSchema), (relay) => {
        const encoded = Schema.encodeSync(RelayInputSchema)(relay)
        expect(Schema.decodeSync(RelayInputSchema)(encoded)).toEqual(relay)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('rejects a relay missing any of the four fields', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(RelayInputSchema)({
        remoteAddr: 'relay.example.com:2333',
        token: 'secret',
        publicKey: 'base64key',
        // serviceName missing
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('ReplaceTunnelRequestBodySchema', () => {
  it('accepts a full replace including the write-only relay block', () => {
    const body = {
      revision: 3,
      publicHost: 'my-clinic.example.com',
      requestedRunning: true,
      relay: {
        remoteAddr: 'relay.example.com:2333',
        token: 'secret',
        publicKey: 'base64key',
        serviceName: 'wildflower',
      },
    }
    expectRightToEqual(Schema.decodeUnknownEither(ReplaceTunnelRequestBodySchema)(body), body)
  })

  it('accepts a replace that omits relay (keep the stored relay)', () => {
    const body = { revision: 1, publicHost: 'my-clinic.example.com', requestedRunning: false }
    expectRightToEqual(Schema.decodeUnknownEither(ReplaceTunnelRequestBodySchema)(body), body)
  })

  it('accepts publicHost present-but-null (explicit clear)', () => {
    const body = { revision: 1, publicHost: null, requestedRunning: false }
    expectRightToEqual(Schema.decodeUnknownEither(ReplaceTunnelRequestBodySchema)(body), body)
  })

  it('rejects a body omitting the required-nullable publicHost', () => {
    // Full-replace semantics: publicHost must be PRESENT (null clears it).
    // An absent key is a decode error, mirroring the Rust RequiredNullable.
    expectLeftToEqual(
      Schema.decodeUnknownEither(ReplaceTunnelRequestBodySchema)({
        revision: 1,
        requestedRunning: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects a body missing the required revision', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(ReplaceTunnelRequestBodySchema)({
        publicHost: null,
        requestedRunning: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})
