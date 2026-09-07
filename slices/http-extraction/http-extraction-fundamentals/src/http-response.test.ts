import { DateTime, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as HttpResponse from './http-response.ts'

const STARTED_AT = DateTime.unsafeMake('2026-01-01T00:00:00.000Z')

const dataWithBody = (body: Uint8Array): HttpResponse.Data => ({
  id: 'req-1',
  url: 'https://example.com/resource/id',
  method: Option.some('GET'),
  status: 200,
  statusText: 'OK',
  headers: [['content-type', 'application/json']],
  startedAt: STARTED_AT,
  body,
})

describe('HttpResponse.make', () => {
  it('carries the source fields through unchanged', () => {
    const response = HttpResponse.make(dataWithBody(new TextEncoder().encode('{}')))

    expect(response.id).toBe('req-1')
    expect(response.url).toBe('https://example.com/resource/id')
    expect(response.status).toBe(200)
    expect(response.statusText).toBe('OK')
    expect(response.headers).toEqual([['content-type', 'application/json']])
    expect(response.startedAt).toBe(STARTED_AT)
  })

  it('decodes text() as UTF-8 of the body', () => {
    const response = HttpResponse.make(dataWithBody(new TextEncoder().encode('{"a":1}')))

    expect(response.text()).toBe('{"a":1}')
  })

  it('returns the body bytes losslessly, even when they are not valid UTF-8', () => {
    const bytes = new Uint8Array([0xff, 0x00, 0xfe, 0x41])
    const response = HttpResponse.make(dataWithBody(bytes))

    expect([...response.bytes()]).toEqual([...bytes])
  })

  it('returns a fresh array from bytes() so a caller cannot mutate the body', () => {
    const response = HttpResponse.make(dataWithBody(new Uint8Array([1, 2, 3])))

    const first = response.bytes()
    first[0] = 9

    expect([...response.bytes()]).toEqual([1, 2, 3])
  })
})
