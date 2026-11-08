import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Either, Exit, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  FhirHttpError,
  FhirRequestDropped,
  FhirResponseNotJson,
  addressedUnderFhirBase,
  SmartClient,
  type FhirRequestError,
} from './smart-client.ts'
import { decodeFhirBaseUrl, SmartConnection } from './smart-connection.ts'
import {
  answerJson,
  answerStatus,
  answerText,
  dropRequest,
  stubFhirServer,
  type StubAnswer,
  type StubFhirServer,
} from './test-helpers.ts'

/** A redeemed sign-in to `https://fhir.example/r4`, the launch's patient `pat-1`. */
const CONNECTION = new SmartConnection({
  fhirBaseUrl: decodeFhirBaseUrl('https://fhir.example/r4/'),
  accessToken: Option.some('token-1'),
  launchPatientId: Option.some('pat-1'),
  grantedScopes: [],
})

/** A stub server answering every request with `answer`. */
const serverAnswering = (
  answer: StubAnswer = answerJson({ resourceType: 'Bundle' })
): StubFhirServer => stubFhirServer({ 'https://': answer, 'http://': answer })

/** The `Authorization` header each request was sent with, or `undefined` for none. */
const authorizationsOf = (server: ReturnType<typeof serverAnswering>): (string | undefined)[] =>
  server.requests.map((request) => request.headers['authorization'])

/** `url` requested through the `SmartClient` for `connection`, over `server`. */
const requestThrough = (
  server: StubFhirServer,
  url: string,
  connection: SmartConnection = CONNECTION
): Effect.Effect<unknown, FhirRequestError> =>
  SmartClient.pipe(
    Effect.flatMap((client) => client.request(url)),
    Effect.provide(SmartClient.layer(connection)),
    Effect.provide(server.transport)
  )

describe('FhirBaseUrl', () => {
  test('decodes without its trailing slashes', () => {
    expect(decodeFhirBaseUrl('https://fhir.example/r4//')).toBe('https://fhir.example/r4')
  })
})

describe('SmartClient.layer', () => {
  test('holds the connection it was built for', async () => {
    const connection = await Effect.runPromise(
      SmartClient.pipe(
        Effect.map((client) => client.connection),
        Effect.provide(SmartClient.layer(CONNECTION)),
        Effect.provide(serverAnswering().transport)
      )
    )

    expect(connection).toBe(CONNECTION)
  })
})

describe('addressedUnderFhirBase', () => {
  const fhirBaseUrl = decodeFhirBaseUrl('https://fhir.example/r4')

  test.each([
    { url: '/Patient?_count=200', resolved: 'https://fhir.example/r4/Patient?_count=200' },
    { url: 'Patient/p1', resolved: 'https://fhir.example/r4/Patient/p1' },
    { url: 'https://fhir.example/r4', resolved: 'https://fhir.example/r4' },
    { url: 'https://fhir.example/r4/Patient', resolved: 'https://fhir.example/r4/Patient' },
    { url: 'Patient/../Observation', resolved: 'https://fhir.example/r4/Observation' },
  ])('resolves $url under the FHIR base', ({ url, resolved }) => {
    expect(addressedUnderFhirBase(url, fhirBaseUrl)).toEqual(Either.right(resolved))
  })

  test.each([
    { url: '../r4-admin/Patient', resolved: 'https://fhir.example/r4-admin/Patient' },
    { url: '%2e%2e/r4-admin/Patient', resolved: 'https://fhir.example/r4-admin/Patient' },
    { url: '/../r4-admin/Patient', resolved: 'https://fhir.example/r4-admin/Patient' },
    {
      url: 'https://fhir.example/r4/../r4-admin/Patient',
      resolved: 'https://fhir.example/r4-admin/Patient',
    },
    {
      url: 'https://fhir.example/r4-admin/Patient',
      resolved: 'https://fhir.example/r4-admin/Patient',
    },
    {
      url: 'https://elsewhere.example/r4/Patient',
      resolved: 'https://elsewhere.example/r4/Patient',
    },
  ])('resolves $url outside the FHIR base', ({ url, resolved }) => {
    expect(addressedUnderFhirBase(url, fhirBaseUrl)).toEqual(Either.left(resolved))
  })
})

describe('SmartClient.request', () => {
  test('resolves a relative URL against the FHIR base, with the bearer token', async () => {
    const server = serverAnswering()

    const body = await Effect.runPromise(requestThrough(server, '/Patient?_count=200'))

    expect(body).toEqual({ resourceType: 'Bundle' })
    expect(server.urls).toEqual(['https://fhir.example/r4/Patient?_count=200'])
    expect(authorizationsOf(server)).toEqual(['Bearer token-1'])
    expect(server.requests[0]?.headers['accept']).toBe('application/json')
  })

  test('resolves a path with no leading slash the same way', async () => {
    const server = serverAnswering()

    await Effect.runPromise(requestThrough(server, 'Patient/p1'))

    expect(server.urls).toEqual(['https://fhir.example/r4/Patient/p1'])
  })

  test('requests an absolute URL under the FHIR base as it is, with the bearer token', async () => {
    const server = serverAnswering()
    const nextLink = 'https://fhir.example/r4?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(requestThrough(server, nextLink))

    expect(server.urls).toEqual([nextLink])
    expect(authorizationsOf(server)).toEqual(['Bearer token-1'])
  })

  test.each([
    { case: 'another origin', url: 'https://elsewhere.example/r4/Patient' },
    { case: 'another path on the same origin', url: 'https://fhir.example/r4-admin/Patient' },
    { case: 'plain http to the same host', url: 'http://fhir.example/r4/Patient' },
  ])('sends no bearer token to $case', async ({ url }) => {
    const server = serverAnswering()

    await Effect.runPromise(requestThrough(server, url))

    expect(server.urls).toEqual([url])
    expect(authorizationsOf(server)).toEqual([undefined])
  })

  test.each([
    { case: 'a relative path', url: '../r4-admin/Patient' },
    { case: 'a percent-encoded relative path', url: '%2e%2e/r4-admin/Patient' },
    { case: 'an absolute URL', url: 'https://fhir.example/r4/../r4-admin/Patient' },
  ])('sends no bearer token to $case whose dot segments leave the FHIR base', async ({ url }) => {
    const server = serverAnswering()

    await Effect.runPromise(requestThrough(server, url))

    expect(server.urls).toEqual(['https://fhir.example/r4-admin/Patient'])
    expect(authorizationsOf(server)).toEqual([undefined])
  })

  test('sends no Authorization header at all for an open server', async () => {
    const server = serverAnswering()

    await Effect.runPromise(
      requestThrough(
        server,
        'Patient',
        new SmartConnection({
          fhirBaseUrl: CONNECTION.fhirBaseUrl,
          accessToken: Option.none(),
          launchPatientId: CONNECTION.launchPatientId,
          grantedScopes: CONNECTION.grantedScopes,
        })
      )
    )

    expect(authorizationsOf(server)).toEqual([undefined])
  })

  test('property: an error status fails with FhirHttpError carrying it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 400, max: 599 }), async (status) => {
        const server = serverAnswering(answerStatus(status))

        const exit = await Effect.runPromiseExit(requestThrough(server, 'Patient'))

        expect(exit).toEqual(
          Exit.fail(
            new FhirHttpError({
              url: 'https://fhir.example/r4/Patient',
              status,
              outcomeText: Option.none(),
            })
          )
        )
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('names the status and the URL in an error status message', async () => {
    const server = serverAnswering(answerStatus(403))

    const failure = await Effect.runPromise(Effect.flip(requestThrough(server, 'Patient')))

    expect(failure.message).toBe('403 from https://fhir.example/r4/Patient')
  })

  test("adds an OperationOutcome's text to an error status message", async () => {
    const server = serverAnswering(
      answerStatus(422, {
        resourceType: 'OperationOutcome',
        issue: [
          { severity: 'error', code: 'invalid', details: { text: 'Unknown search parameter' } },
          { severity: 'error', code: 'invalid', diagnostics: 'Parameter: frobnicate' },
          { severity: 'warning', code: 'informational' },
        ],
      })
    )

    const failure = await Effect.runPromise(Effect.flip(requestThrough(server, 'Patient')))

    expect(failure.message).toBe(
      '422 from https://fhir.example/r4/Patient: Unknown search parameter; Parameter: frobnicate'
    )
  })

  test('keeps an error status message bare when the body is no OperationOutcome', async () => {
    const server = serverAnswering(answerStatus(500, { resourceType: 'Patient', id: 'p1' }))

    const failure = await Effect.runPromise(Effect.flip(requestThrough(server, 'Patient')))

    expect(failure.message).toBe('500 from https://fhir.example/r4/Patient')
  })

  test('fails with FhirRequestDropped when no response arrives', async () => {
    const server = serverAnswering(dropRequest)

    const failure = await Effect.runPromise(Effect.flip(requestThrough(server, 'Patient')))

    expect(failure).toBeInstanceOf(FhirRequestDropped)
    expect(failure).toMatchObject({ url: 'https://fhir.example/r4/Patient' })
  })

  test('fails with FhirResponseNotJson when a success carries no JSON', async () => {
    const server = serverAnswering(answerText('<html>'))

    const failure = await Effect.runPromise(Effect.flip(requestThrough(server, 'Patient')))

    expect(failure).toBeInstanceOf(FhirResponseNotJson)
    expect(failure).toMatchObject({ url: 'https://fhir.example/r4/Patient' })
  })
})
