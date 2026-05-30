import { strict as assert } from 'node:assert'
import { Predicate, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import { GatekeeperBridge } from './bridge.ts'

describe('GatekeeperBridge', () => {
  test('exposes both host→web tags', () => {
    expect(Object.keys(GatekeeperBridge.Web.InboundSchemas).toSorted()).toEqual([
      'AuthTokenIssued',
      'WaitForToken',
    ])
  })

  test('WaitForToken URL schema encodes to a bare flag', () => {
    const schema = GatekeeperBridge.UrlParamSchemas.WaitForToken
    assert(Predicate.isNotUndefined(schema), 'WaitForToken URL schema missing')
    expect(Schema.encodeSync(schema)({ _tag: 'WaitForToken' })).toBe('')
    expect(Schema.decodeSync(schema)('')).toEqual({ _tag: 'WaitForToken' })
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
})
