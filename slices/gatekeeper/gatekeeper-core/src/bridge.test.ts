import { strict as assert } from 'node:assert'
import { Predicate, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import { GatekeeperBridge } from './bridge.ts'

describe('GatekeeperBridge', () => {
  test('exposes both host→web tags', () => {
    expect(Object.keys(GatekeeperBridge.HostToWeb).toSorted()).toEqual([
      'AuthTokenIssued',
      'DeviceConsentRequested',
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

  test('DeviceConsentRequested has no URL schema — push-only Tauri-event tag', () => {
    expect(GatekeeperBridge.UrlParamSchemas.DeviceConsentRequested).toBeUndefined()
  })

  test('DeviceConsentRequested round-trips a userCode and null', () => {
    const schema = GatekeeperBridge.HostToWeb.DeviceConsentRequested
    const decode = Schema.decodeSync(schema)
    const encode = Schema.encodeSync(schema)
    expect(decode('{"_tag":"DeviceConsentRequested","userCode":"ABC-123"}')).toEqual({
      _tag: 'DeviceConsentRequested',
      userCode: 'ABC-123',
    })
    expect(decode('{"_tag":"DeviceConsentRequested","userCode":null}')).toEqual({
      _tag: 'DeviceConsentRequested',
      userCode: null,
    })
    expect(encode({ _tag: 'DeviceConsentRequested', userCode: 'XYZ-789' })).toBe(
      '{"_tag":"DeviceConsentRequested","userCode":"XYZ-789"}'
    )
    expect(encode({ _tag: 'DeviceConsentRequested', userCode: null })).toBe(
      '{"_tag":"DeviceConsentRequested","userCode":null}'
    )
  })
})
