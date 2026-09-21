import { Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import { GatekeeperBridge } from './bridge.ts'

describe('GatekeeperBridge', () => {
  test('exposes both host→web tags', () => {
    expect(Object.keys(GatekeeperBridge.HostToWeb).toSorted()).toEqual([
      'AuthTokenIssued',
      'PendingConsentRequested',
    ])
  })

  test('no tags carry a URL-param schema — the bearer must not be embeddable in a URL', () => {
    expect(GatekeeperBridge.UrlParamSchemas.AuthTokenIssued).toBeUndefined()
    expect(GatekeeperBridge.UrlParamSchemas.PendingConsentRequested).toBeUndefined()
  })

  test('AuthTokenIssued is a contentless notify — the wire shape carries no token', () => {
    const schema = GatekeeperBridge.HostToWeb.AuthTokenIssued
    expect(Schema.decodeSync(schema)('{"_tag":"AuthTokenIssued"}')).toEqual({
      _tag: 'AuthTokenIssued',
    })
    expect(Schema.encodeSync(schema)({ _tag: 'AuthTokenIssued' })).toBe(
      '{"_tag":"AuthTokenIssued"}'
    )
  })

  describe('PendingConsentRequested', () => {
    const schema = GatekeeperBridge.HostToWeb.PendingConsentRequested
    const decode = Schema.decodeSync(schema)
    const encode = Schema.encodeSync(schema)

    // The three wire forms the Rust side pins golden tests against
    // (gatekeeper-rust/src/bridge.rs): a cleared head and one per flow.
    test('round-trips a device head', () => {
      const wire =
        '{"_tag":"PendingConsentRequested","head":{"kind":"device","userCode":"ABC-123"}}'
      const value = {
        _tag: 'PendingConsentRequested',
        head: { kind: 'device', userCode: 'ABC-123' },
      } as const
      expect(decode(wire)).toEqual(value)
      expect(encode(value)).toBe(wire)
    })

    test('round-trips an oauth head', () => {
      const wire = '{"_tag":"PendingConsentRequested","head":{"kind":"oauth","id":"req-1"}}'
      const value = {
        _tag: 'PendingConsentRequested',
        head: { kind: 'oauth', id: 'req-1' },
      } as const
      expect(decode(wire)).toEqual(value)
      expect(encode(value)).toBe(wire)
    })

    test('round-trips the cleared head — null is the host-side dismiss sentinel', () => {
      const wire = '{"_tag":"PendingConsentRequested","head":null}'
      const value = { _tag: 'PendingConsentRequested', head: null } as const
      expect(decode(wire)).toEqual(value)
      expect(encode(value)).toBe(wire)
    })

    // The `kind` discriminator is what routes the popup to a consent endpoint.
    // A head that decoded with the wrong key present (or an unknown kind) would
    // send the modal to fetch a request id from the device endpoint, so the
    // union must reject rather than coerce.
    test.each([
      ['an unknown kind', '{"_tag":"PendingConsentRequested","head":{"kind":"sms","id":"x"}}'],
      [
        'a device head missing its userCode',
        '{"_tag":"PendingConsentRequested","head":{"kind":"device"}}',
      ],
      [
        'an oauth head missing its id',
        '{"_tag":"PendingConsentRequested","head":{"kind":"oauth"}}',
      ],
      [
        'a device head keyed by id',
        '{"_tag":"PendingConsentRequested","head":{"kind":"device","id":"req-1"}}',
      ],
      ['a bare string head', '{"_tag":"PendingConsentRequested","head":"ABC-123"}'],
    ])('rejects %s', (_label, wire) => {
      expect(() => decode(wire)).toThrow()
    })
  })
})
