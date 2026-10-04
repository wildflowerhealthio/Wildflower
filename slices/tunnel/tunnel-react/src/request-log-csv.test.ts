import { DateTime, Option } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { LoggedRequest } from './queries.ts'
import { requestLogCsv } from './request-log-csv.ts'

const request = (overrides: Partial<LoggedRequest>): LoggedRequest => ({
  id: 1,
  receivedAt: DateTime.unsafeMake('2026-07-01T12:00:00Z'),
  clientId: Option.some('lifting'),
  address: Option.some('198.51.100.24'),
  servedHost: Option.some('dev1.example.com'),
  method: 'GET',
  path: '/fhir-r4/Patient',
  status: 200,
  responseBytes: Option.none(),
  durationMs: 12,
  refusal: Option.none(),
  ...overrides,
})

const bodyOf = (csv: string): readonly string[] => csv.trimEnd().split('\r\n').slice(1)

describe('requestLogCsv', () => {
  test('writes a header row and one CRLF-terminated row per request', () => {
    const csv = requestLogCsv([request({})], new Map([['lifting', 'Lifting app']]))

    expect(csv).toBe(
      'received_at,client_id,client_name,access,address,served_host,method,path,status,refusal,response_bytes,duration_ms\r\n' +
        '2026-07-01T12:00:00.000Z,lifting,Lifting app,authorized,198.51.100.24,dev1.example.com,GET,/fhir-r4/Patient,200,,,12\r\n'
    )
  })

  test('quotes fields holding commas, quotes or line breaks', () => {
    const csv = requestLogCsv(
      [request({ clientId: Option.some('a') })],
      new Map([['a', 'Say "hi", then\nleave']])
    )

    expect(bodyOf(csv)[0]).toContain(',"Say ""hi"", then\nleave",')
  })

  test('neutralizes values a spreadsheet would run as a formula', () => {
    const csv = requestLogCsv(
      [
        request({
          clientId: Option.none(),
          address: Option.some('=HYPERLINK("x")'),
          method: '+SUM',
          servedHost: Option.some('@x'),
        }),
      ],
      new Map()
    )

    expect(bodyOf(csv)[0]).toBe(
      `2026-07-01T12:00:00.000Z,,Unauthenticated,public,"'=HYPERLINK(""x"")",'@x,'+SUM,/fhir-r4/Patient,200,,,12`
    )
  })
})
