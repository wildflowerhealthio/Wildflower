import { Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import { GatekeeperBridge } from './bridge.ts'

describe('GatekeeperBridge', () => {
  test('exposes both host→web tags', () => {
    expect(Object.keys(GatekeeperBridge.HostToWeb).toSorted()).toEqual([
      'AuthTokenIssued',
      'DeviceConsentRequested',
    ])
  })

  test('no tags carry a URL-param schema — the bearer must not be embeddable in a URL', () => {
    expect(GatekeeperBridge.UrlParamSchemas.AuthTokenIssued).toBeUndefined()
    expect(GatekeeperBridge.UrlParamSchemas.DeviceConsentRequested).toBeUndefined()
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
