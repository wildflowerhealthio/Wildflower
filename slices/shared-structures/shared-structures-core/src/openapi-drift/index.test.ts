import { describe, expect, test } from 'vite-plus/test'
import { collectSpecDrift, type OpenApiDoc, type SchemaObject } from './index.ts'

// Build a one-operation doc whose response 200 carries `schema`.
const responseDoc = (path: string, method: string, schema: SchemaObject): OpenApiDoc => ({
  paths: {
    [path]: { [method]: { responses: { '200': { content: { 'application/json': { schema } } } } } },
  },
})

// Build a one-operation doc whose request body carries `schema`.
const requestDoc = (path: string, method: string, schema: SchemaObject): OpenApiDoc => ({
  paths: {
    [path]: { [method]: { requestBody: { content: { 'application/json': { schema } } } } },
  },
})

const obj = (
  fields: Record<string, SchemaObject>,
  required: ReadonlyArray<string>
): SchemaObject => ({ type: 'object', required, properties: fields })

const str: SchemaObject = { type: 'string' }
const scope = [['/x', 'get']] as const

describe('collectSpecDrift', () => {
  test('identical specs have no drift', () => {
    const s = responseDoc('/x', 'get', obj({ a: str }, ['a']))
    const c = responseDoc('/x', 'get', obj({ a: str }, ['a']))
    expect(collectSpecDrift(s, c, { scope })).toEqual([])
  })

  test('a field the server returns but the client omits is drift', () => {
    const s = responseDoc('/x', 'get', obj({ a: str, b: str }, ['a', 'b']))
    const c = responseDoc('/x', 'get', obj({ a: str }, ['a']))
    expect(collectSpecDrift(s, c, { scope })).toEqual([
      'GET /x 200 response.b: on server, MISSING from client',
    ])
  })

  test('required-ness mismatch is drift', () => {
    const s = responseDoc('/x', 'get', obj({ a: str }, ['a']))
    const c = responseDoc('/x', 'get', obj({ a: str }, []))
    expect(collectSpecDrift(s, c, { scope })).toEqual([
      'GET /x 200 response.a: required server=true client=false',
    ])
  })

  test('a union variant only on the server is drift', () => {
    const member = (tag: string, extra: string): SchemaObject =>
      obj({ kind: { type: 'string', enum: [tag] }, [extra]: str }, ['kind', extra])
    const s = responseDoc('/x', 'get', {
      oneOf: [member('a', 'x'), member('b', 'y'), member('c', 'z')],
    })
    const c = responseDoc('/x', 'get', { anyOf: [member('a', 'x'), member('b', 'y')] })
    expect(collectSpecDrift(s, c, { scope })).toEqual([
      'GET /x 200 response: union member only on server: {kind: string, z: string}',
    ])
  })

  test("Effect's HttpApiDecodeError union member is stripped, not flagged", () => {
    const decodeErr: SchemaObject = obj(
      { _tag: { type: 'string', enum: ['HttpApiDecodeError'] }, message: str },
      ['_tag', 'message']
    )
    const err = obj({ error: str }, ['error'])
    const s = responseDoc('/x', 'get', err)
    const c = responseDoc('/x', 'get', { anyOf: [decodeErr, err] })
    expect(collectSpecDrift(s, c, { scope })).toEqual([])
  })

  test('a client `unknown`/empty schema is a wildcard against any server shape', () => {
    const s = responseDoc('/x', 'get', obj({ a: obj({ deep: str }, ['deep']) }, ['a']))
    const c = responseDoc('/x', 'get', obj({ a: {} }, ['a'])) // Schema.Unknown → {}
    expect(collectSpecDrift(s, c, { scope })).toEqual([])
  })

  test('nullable on one side and bare primitive on the other are equivalent', () => {
    const s = responseDoc('/x', 'get', obj({ a: { type: ['string', 'null'] } }, []))
    const c = responseDoc('/x', 'get', obj({ a: str }, []))
    expect(collectSpecDrift(s, c, { scope })).toEqual([])
  })

  test('an endpoint in both specs but absent from scope is flagged', () => {
    const s = responseDoc('/y', 'post', obj({ a: str }, ['a']))
    const c = responseDoc('/y', 'post', obj({ a: str }, ['a']))
    expect(collectSpecDrift(s, c, { scope: [] })).toEqual([
      'POST /y: present in both specs but not in scope — add it',
    ])
  })

  test('responsesNotCompared skips response bodies but still scopes the endpoint', () => {
    const s = responseDoc('/x', 'get', obj({ a: str }, ['a']))
    const c = responseDoc('/x', 'get', obj({ b: str }, ['b'])) // would drift if compared
    expect(collectSpecDrift(s, c, { scope, responsesNotCompared: new Set(['get /x']) })).toEqual([])
  })

  test('a request body the server and client disagree on is drift when compared', () => {
    const s = requestDoc('/x', 'get', obj({ a: str }, ['a']))
    const c = requestDoc('/x', 'get', obj({ b: str }, ['b']))
    expect(collectSpecDrift(s, c, { scope })).toEqual([
      'GET /x requestBody.a: on server, MISSING from client',
      'GET /x requestBody.b: on client, MISSING from server',
    ])
  })

  test('requestsNotCompared skips the request body but still scopes the endpoint', () => {
    const s = requestDoc('/x', 'get', obj({ a: str }, ['a']))
    const c = requestDoc('/x', 'get', obj({ b: str }, ['b'])) // would drift if compared
    expect(collectSpecDrift(s, c, { scope, requestsNotCompared: new Set(['get /x']) })).toEqual([])
  })

  test('requestsNotCompared still compares responses of the same endpoint', () => {
    const s: OpenApiDoc = {
      paths: {
        '/x': {
          get: {
            requestBody: { content: { 'application/json': { schema: obj({ a: str }, ['a']) } } },
            responses: {
              '200': { content: { 'application/json': { schema: obj({ r: str }, ['r']) } } },
            },
          },
        },
      },
    }
    const c: OpenApiDoc = {
      paths: {
        '/x': {
          get: {
            requestBody: { content: { 'application/json': { schema: obj({ b: str }, ['b']) } } }, // excluded
            responses: { '200': { content: { 'application/json': { schema: obj({}, []) } } } }, // drifts
          },
        },
      },
    }
    expect(collectSpecDrift(s, c, { scope, requestsNotCompared: new Set(['get /x']) })).toEqual([
      'GET /x 200 response.r: on server, MISSING from client',
    ])
  })
})
