import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  freshTunnelState as FRESH_STATE,
  RelayInputSchema,
  ReplaceTunnelRequestBodySchema,
  TunnelStateViewSchema,
} from './tunnel.ts'

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

  it('accepts a fresh-install snapshot', () => {
    expectRightToEqual(Schema.decodeUnknownEither(TunnelStateViewSchema)(FRESH_STATE), FRESH_STATE)
  })

  it('accepts a running snapshot with a public host, served origin, and relay view', () => {
    const running = {
      settingsRevision: 7,
      publicHost: 'my-clinic.example.com',
      requestedRunning: true,
      status: 'verified' as const,
      running: true,
      error: null,
      dialAttempts: 2,
      servedOrigin: 'https://my-clinic.example.com',
      // The relay view is the non-secret fields only — no token.
      relay: {
        remoteAddr: 'relay.example.com:2333',
        publicKey: 'base64key',
        serviceName: 'wildflower',
      },
    }
    expectRightToEqual(Schema.decodeUnknownEither(TunnelStateViewSchema)(running), running)
  })

  it('strips a stray token from the relay view (token is never part of the view)', () => {
    // Defense in depth: even if the wire carried a token, the view schema
    // drops it so it can't leak into the client's cache.
    const decoded = Schema.decodeUnknownSync(TunnelStateViewSchema)({
      ...FRESH_STATE,
      relay: {
        remoteAddr: 'relay.example.com:2333',
        publicKey: 'base64key',
        serviceName: 'wildflower',
        token: 'leaked',
      },
    })
    expect(decoded.relay).toEqual({
      remoteAddr: 'relay.example.com:2333',
      publicKey: 'base64key',
      serviceName: 'wildflower',
    })
  })

  it('decodes the 409 conflict body — same shape, just a newer revision', () => {
    // The PUT 409 carries the current snapshot via TunnelStateViewSchema, so a
    // bumped-revision body must decode like any other state.
    const conflict = { ...FRESH_STATE, settingsRevision: 42 }
    expectRightToEqual(Schema.decodeUnknownEither(TunnelStateViewSchema)(conflict), conflict)
  })

  it('rejects state missing the required requestedRunning flag', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(TunnelStateViewSchema)({
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
      settingsRevision: 3,
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
    const body = {
      settingsRevision: 1,
      publicHost: 'my-clinic.example.com',
      requestedRunning: false,
    }
    expectRightToEqual(Schema.decodeUnknownEither(ReplaceTunnelRequestBodySchema)(body), body)
  })

  it('accepts publicHost present-but-null (explicit clear)', () => {
    const body = { settingsRevision: 1, publicHost: null, requestedRunning: false }
    expectRightToEqual(Schema.decodeUnknownEither(ReplaceTunnelRequestBodySchema)(body), body)
  })

  it('rejects a body omitting the required-nullable publicHost', () => {
    // Full-replace semantics: publicHost must be PRESENT (null clears it).
    // An absent key is a decode error, mirroring the Rust RequiredNullable.
    expectLeftToEqual(
      Schema.decodeUnknownEither(ReplaceTunnelRequestBodySchema)({
        settingsRevision: 1,
        requestedRunning: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects a body missing the required settingsRevision', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(ReplaceTunnelRequestBodySchema)({
        publicHost: null,
        requestedRunning: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})
