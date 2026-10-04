import { DateTime, Option } from 'effect'

import type { LoggedRequest } from './queries.ts'
import { callerNameOf, requestAccessOf } from './request-log.ts'

/** The suggested name of an exported request log. */
const REQUEST_LOG_CSV_FILE_NAME = 'tunnel-requests.csv'

const COLUMNS = [
  'received_at',
  'client_id',
  'client_name',
  'access',
  'address',
  'served_host',
  'method',
  'path',
  'status',
  'refusal',
  'response_bytes',
  'duration_ms',
] as const

/**
 * One CSV field (RFC 4180): quoted when it holds a comma, quote or line break,
 * with its quotes doubled. A value a spreadsheet would run as a formula (a
 * leading `=`, `+`, `-`, `@`, tab or carriage return) is prefixed with `'`, since
 * addresses, hosts and methods come from whoever called the tunnel.
 */
const csvField = (value: string | number): string => {
  const text = String(value)
  const inert = typeof value === 'string' && /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text
  return /[",\r\n]/u.test(inert) ? `"${inert.replaceAll('"', '""')}"` : inert
}

/** An optional CSV field: {@link csvField} when present, empty when not. */
const optionalCsvField: (value: Option.Option<string | number>) => string = Option.match({
  onNone: () => '',
  onSome: csvField,
})

/**
 * The request log as CSV, one row per request in the order given, under a
 * header row. `names` resolves `client_name` as the table does; `access` is the
 * request's `auth` case — `authorized`, `public` or `refused`.
 */
const requestLogCsv = (
  requests: readonly LoggedRequest[],
  names: ReadonlyMap<string, string>
): string => {
  const rows = requests.map((request) =>
    [
      csvField(DateTime.formatIso(request.receivedAt)),
      optionalCsvField(request.clientId),
      csvField(callerNameOf(request.clientId, names)),
      csvField(requestAccessOf(request).auth),
      optionalCsvField(request.address),
      optionalCsvField(request.servedHost),
      csvField(request.method),
      csvField(request.path),
      csvField(request.status),
      optionalCsvField(request.refusal),
      optionalCsvField(request.responseBytes),
      csvField(request.durationMs),
    ].join(',')
  )
  return [COLUMNS.join(','), ...rows].map((line) => `${line}\r\n`).join('')
}

/**
 * Hand a CSV to the browser as a downloaded file, through a transient
 * object-URL anchor. The revoke waits a tick so a webview still fetching the
 * blob URL for a large export doesn't lose it.
 */
const saveCsv = (csv: string, fileName: string): void => {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 0)
}

export { REQUEST_LOG_CSV_FILE_NAME, requestLogCsv, saveCsv }
