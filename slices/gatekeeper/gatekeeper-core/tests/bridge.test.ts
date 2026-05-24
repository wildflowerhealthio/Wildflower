import { Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import GatekeeperBridge from '../src/bridge.ts'

describe('GatekeeperBridge', () => {
  test('exposes both host→web tags', () => {
    expect(Object.keys(GatekeeperBridge.Web.InboundSchemas).toSorted()).toEqual([
      'AuthTokenIssued',
      'WaitForToken',
    ])
  })

  test('AuthTokenIssued and WaitForToken both ride URL params', () => {
    expect(GatekeeperBridge.UrlParamSchemas.AuthTokenIssued).toBeDefined()
    expect(GatekeeperBridge.UrlParamSchemas.WaitForToken).toBeDefined()
  })

  test('WaitForToken URL schema encodes to a bare flag', () => {
    const schema = GatekeeperBridge.UrlParamSchemas.WaitForToken
    if (schema === undefined) throw new Error('WaitForToken URL schema missing')
    expect(Schema.encodeSync(schema)({ _tag: 'WaitForToken' })).toBe('')
    expect(Schema.decodeSync(schema)('')).toEqual({ _tag: 'WaitForToken' })
  })

  test('AuthTokenIssued URL schema round-trips the token', () => {
    const schema = GatekeeperBridge.UrlParamSchemas.AuthTokenIssued
    if (schema === undefined) throw new Error('AuthTokenIssued URL schema missing')
    expect(Schema.encodeSync(schema)({ _tag: 'AuthTokenIssued', token: 'abc.def' })).toBe('abc.def')
    expect(Schema.decodeSync(schema)('abc.def')).toEqual({
      _tag: 'AuthTokenIssued',
      token: 'abc.def',
    })
  })
})
