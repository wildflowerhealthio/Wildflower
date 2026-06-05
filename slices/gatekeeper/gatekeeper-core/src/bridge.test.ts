import { strict as assert } from 'node:assert'
import { Predicate, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import { GatekeeperBridge } from './bridge.ts'

describe('GatekeeperBridge', () => {
  test('exposes both host→web tags', () => {
    expect(Object.keys(GatekeeperBridge.HostToWeb).toSorted()).toEqual([
      'AuthTokenIssued',
      'DeviceAuthorizationActiveChanged',
    ])
  })

  test('AuthTokenIssued URL schema round-trips the token', () => {
    const schema = GatekeeperBridge.UrlParamSchemas.AuthTokenIssued
    assert(Predicate.isNotUndefined(schema), 'AuthTokenIssued URL schema missing')
    expect(Schema.encodeSync(schema)({ _tag: 'AuthTokenIssued', token: 'abc.def' })).toBe('abc.def')
    expect(Schema.decodeSync(schema)('abc.def')).toEqual({
      _tag: 'AuthTokenIssued',
      token: 'abc.def',
    })
  })

  test('DeviceAuthorizationActiveChanged round-trips a userCode and null', () => {
    const schema = GatekeeperBridge.HostToWeb.DeviceAuthorizationActiveChanged
    for (const userCode of ['ABCD-1234', null]) {
      const message = { _tag: 'DeviceAuthorizationActiveChanged', userCode } as const
      expect(Schema.decodeSync(schema)(Schema.encodeSync(schema)(message))).toEqual(message)
    }
  })

  test('DeviceAuthorizationActiveChanged is push-only — no URL param schema', () => {
    expect(GatekeeperBridge.UrlParamSchemas.DeviceAuthorizationActiveChanged).toBeUndefined()
  })
})
