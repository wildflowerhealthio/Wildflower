import { strict as assert } from 'node:assert'
import { Predicate, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import { GatekeeperBridge } from './bridge.ts'

describe('GatekeeperBridge', () => {
  test('exposes only the AuthTokenIssued host→web tag', () => {
    expect(Object.keys(GatekeeperBridge.Web.InboundSchemas).toSorted()).toEqual(['AuthTokenIssued'])
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
