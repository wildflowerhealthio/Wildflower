import { HttpClient, HttpClientError, HttpClientResponse } from '@effect/platform'
import { Cause, DateTime, Effect, Exit, Option, ParseResult } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { readServerHealth } from './server-health.ts'

/** A `/health` check object as the server serves it. */
const check = (status: string): Readonly<Record<string, string>> => ({
  componentType: 'system',
  status,
  time: '2026-10-08T12:00:00Z',
})

/**
 * Run `readServerHealth('ruth.relay.example.com')` against a client that
 * answers every request with `response`, and return its exit with the URLs
 * it was asked for.
 */
const readAgainst = async (
  response: () => Response
): Promise<{
  readonly exit: Exit.Exit<unknown, unknown>
  readonly urls: readonly string[]
}> => {
  const urls: string[] = []
  const client = HttpClient.make((request) => {
    urls.push(request.url)
    return Effect.succeed(HttpClientResponse.fromWeb(request, response()))
  })
  const exit = await Effect.runPromiseExit(
    readServerHealth('ruth.relay.example.com').pipe(
      Effect.provideService(HttpClient.HttpClient, client)
    )
  )
  return { exit, urls }
}

/** The error `exit` failed with, or `undefined` when it succeeded. */
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined

describe('readServerHealth', () => {
  it("should read a passing report, with its checks, from the server's public /health", async () => {
    // Act
    const { exit, urls } = await readAgainst(() =>
      Response.json({
        status: 'pass',
        checks: { server: [check('pass')], 'fhir-r4': [check('pass')] },
      })
    )

    // Assert
    expect(urls).toEqual(['https://ruth.relay.example.com/health'])
    expect(exit).toEqual(
      Exit.succeed({
        status: 'pass',
        checks: {
          server: [
            {
              componentType: 'system',
              status: 'pass',
              time: DateTime.unsafeMake('2026-10-08T12:00:00Z'),
            },
          ],
          'fhir-r4': [
            {
              componentType: 'system',
              status: 'pass',
              time: DateTime.unsafeMake('2026-10-08T12:00:00Z'),
            },
          ],
        },
      })
    )
  })

  it('should read a failing report from its 503', async () => {
    // Act
    const { exit } = await readAgainst(() =>
      Response.json({ status: 'fail', checks: { connectivity: [check('fail')] } }, { status: 503 })
    )

    // Assert
    expect(Exit.isSuccess(exit) ? exit.value : undefined).toMatchObject({
      status: 'fail',
      checks: { connectivity: [{ status: 'fail' }] },
    })
  })

  it('should read a report with no checks as having none', async () => {
    // Act
    const { exit } = await readAgainst(() => Response.json({ status: 'pass' }))

    // Assert
    expect(exit).toEqual(Exit.succeed({ status: 'pass', checks: {} }))
  })

  it.each([404, 500, 502])(
    'should fail with the status when /health answers %i',
    async (status) => {
      // Act
      const { exit } = await readAgainst(() => Response.json({ status: 'pass' }, { status }))

      // Assert
      const error = failureOf(exit)
      expect(error).toBeInstanceOf(HttpClientError.ResponseError)
      expect(error).toMatchObject({ reason: 'StatusCode', response: { status } })
    }
  )

  it("should fail to decode a body that isn't a health report", async () => {
    // Act
    const { exit } = await readAgainst(() => Response.json({ status: 'fine' }))

    // Assert
    expect(failureOf(exit)).toBeInstanceOf(ParseResult.ParseError)
  })
})
