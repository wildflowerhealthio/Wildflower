import { HttpServerRequest, HttpServerResponse } from '@effect/platform'
import type { Layer } from 'effect'
import { Effect, Logger, LogLevel } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { accessLogMiddleware } from './access-log-middleware.ts'

const messageText = (message: unknown): string => {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) return message.map((m) => String(m)).join(' ')
  return String(message)
}

const makeCapturingLogger = (): {
  readonly captured: string[]
  readonly layer: Layer.Layer<never>
} => {
  const captured: string[] = []
  const logger = Logger.make(({ message }) => {
    captured.push(messageText(message))
  })
  return { captured, layer: Logger.replace(Logger.defaultLogger, logger) }
}

const runAccessLog = async ({
  url,
  method,
  status,
}: {
  readonly url: string
  readonly method?: string
  readonly status?: number
}): Promise<{
  readonly response: HttpServerResponse.HttpServerResponse
  readonly logs: string[]
}> => {
  const { captured, layer } = makeCapturingLogger()
  const inner = HttpServerResponse.text('ok', { status: status ?? 200 })
  const request = HttpServerRequest.fromWeb(
    new Request(`http://test.invalid${url}`, { method: method ?? 'GET' })
  )
  const response = await Effect.runPromise(
    accessLogMiddleware(Effect.succeed(inner)).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Logger.withMinimumLogLevel(LogLevel.Debug),
      Effect.provide(layer)
    )
  )
  return { response, logs: captured }
}

describe('accessLogMiddleware', () => {
  test('returns the inner response unchanged', async () => {
    const { response } = await runAccessLog({ url: '/foo', status: 201 })
    expect(response.status).toBe(201)
  })

  test('emits one log line in `[http] METHOD PATH -> STATUS` form', async () => {
    const { logs } = await runAccessLog({ url: '/foo', method: 'POST', status: 204 })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^\[http] POST \/foo -> 204 \(\d+ms\)$/)
  })

  test('strips the query string from the logged path', async () => {
    const { logs } = await runAccessLog({ url: '/bootstrap?token=secret', status: 200 })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('/bootstrap ')
    expect(logs[0]).not.toContain('token=secret')
    expect(logs[0]).not.toContain('?')
  })

  test('logs path with no query string verbatim', async () => {
    const { logs } = await runAccessLog({ url: '/no-query', status: 200 })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(' /no-query ')
  })

  test('logging is independent of query-string content (property)', async () => {
    // Run the same path twice — once with a query string, once without — and
    // assert both log lines are identical modulo the elapsed-time field. This
    // catches any regression where query material leaks into the log (which is
    // the whole point of the `indexOf('?')` strip).
    await fc.assert(
      fc.asyncProperty(fc.webPath(), fc.webQueryParameters(), async (path, query) => {
        const { logs: withQuery } = await runAccessLog({ url: `${path}?${query}`, status: 200 })
        const { logs: noQuery } = await runAccessLog({ url: path, status: 200 })
        expect(withQuery).toHaveLength(1)
        expect(noQuery).toHaveLength(1)
        expect(stripElapsed(withQuery[0])).toBe(stripElapsed(noQuery[0]))
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

// Helpers
const stripElapsed = (line: string): string => line.replace(/\(\d+ms\)$/, '(Nms)')
