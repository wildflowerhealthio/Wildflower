import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Exit, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  FhirHttpError,
  FhirRequestDropped,
  FhirResponseNotJson,
  smartClientFor,
  type SmartConnection,
} from './smart-client.ts'
import {
  answerJson,
  answerStatus,
  answerText,
  dropRequest,
  stubFhirServer,
  type StubAnswer,
  type StubFhirServer,
} from './test-helpers.ts'

/** A redeemed session against `https://fhir.example/r4`, the launch's patient `pat-1`. */
const SESSION: SmartConnection = {
  serverUrl: 'https://fhir.example/r4/',
  accessToken: 'token-1',
  patient: 'pat-1',
}

/** A stub server answering every request with `answer`. */
const serverAnswering = (
  answer: StubAnswer = answerJson({ resourceType: 'Bundle' })
): StubFhirServer => stubFhirServer({ 'https://': answer, 'http://': answer })

/** The `Authorization` header each request was sent with, or `undefined` for none. */
const authorizationsOf = (server: ReturnType<typeof serverAnswering>): (string | undefined)[] =>
  server.requests.map((request) => request.headers['authorization'])

describe('smartClientFor', () => {
  test('names the server without its trailing slash, the token and the launch patient', () => {
    const client = smartClientFor(SESSION, serverAnswering().transport)

    expect({
      serverUrl: client.serverUrl,
      accessToken: client.accessToken,
      launchPatientId: client.launchPatientId,
    }).toEqual({
      serverUrl: 'https://fhir.example/r4',
      accessToken: 'token-1',
      launchPatientId: Option.some('pat-1'),
    })
  })

  test.each([undefined, ''])('has no launch patient when the session names %j', (patient) => {
    const client = smartClientFor({ ...SESSION, patient }, serverAnswering().transport)

    expect(client.launchPatientId).toEqual(Option.none())
  })
})

describe('SmartClient.request', () => {
  test('resolves a relative URL against the FHIR base, with the bearer token', async () => {
    const server = serverAnswering()
    const client = smartClientFor(SESSION, server.transport)

    const body = await Effect.runPromise(client.request('/Patient?_count=200'))

    expect(body).toEqual({ resourceType: 'Bundle' })
    expect(server.urls).toEqual(['https://fhir.example/r4/Patient?_count=200'])
    expect(authorizationsOf(server)).toEqual(['Bearer token-1'])
    expect(server.requests[0]?.headers['accept']).toBe('application/json')
  })

  test('resolves a path with no leading slash the same way', async () => {
    const server = serverAnswering()

    await Effect.runPromise(smartClientFor(SESSION, server.transport).request('Patient/p1'))

    expect(server.urls).toEqual(['https://fhir.example/r4/Patient/p1'])
  })

  test('requests an absolute URL under the FHIR base as it is, with the bearer token', async () => {
    const server = serverAnswering()
    const nextLink = 'https://fhir.example/r4?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(smartClientFor(SESSION, server.transport).request(nextLink))

    expect(server.urls).toEqual([nextLink])
    expect(authorizationsOf(server)).toEqual(['Bearer token-1'])
  })

  test.each([
    { case: 'another origin', url: 'https://elsewhere.example/r4/Patient' },
    { case: 'another path on the same origin', url: 'https://fhir.example/r4-admin/Patient' },
    { case: 'plain http to the same host', url: 'http://fhir.example/r4/Patient' },
  ])('sends no bearer token to $case', async ({ url }) => {
    const server = serverAnswering()

    await Effect.runPromise(smartClientFor(SESSION, server.transport).request(url))

    expect(server.urls).toEqual([url])
    expect(authorizationsOf(server)).toEqual([undefined])
  })

  test('sends no Authorization header at all for an open server', async () => {
    const server = serverAnswering()
    const client = smartClientFor({ ...SESSION, accessToken: undefined }, server.transport)

    await Effect.runPromise(client.request('Patient'))

    expect(authorizationsOf(server)).toEqual([undefined])
  })

  test('property: an error status fails with FhirHttpError carrying it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 400, max: 599 }), async (status) => {
        const server = serverAnswering(answerStatus(status))

        const exit = await Effect.runPromiseExit(
          smartClientFor(SESSION, server.transport).request('Patient')
        )

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

    const failure = await Effect.runPromise(
      Effect.flip(smartClientFor(SESSION, server.transport).request('Patient'))
    )

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

    const failure = await Effect.runPromise(
      Effect.flip(smartClientFor(SESSION, server.transport).request('Patient'))
    )

    expect(failure.message).toBe(
      '422 from https://fhir.example/r4/Patient: Unknown search parameter; Parameter: frobnicate'
    )
  })

  test('keeps an error status message bare when the body is no OperationOutcome', async () => {
    const server = serverAnswering(answerStatus(500, { resourceType: 'Patient', id: 'p1' }))

    const failure = await Effect.runPromise(
      Effect.flip(smartClientFor(SESSION, server.transport).request('Patient'))
    )

    expect(failure.message).toBe('500 from https://fhir.example/r4/Patient')
  })

  test('fails with FhirRequestDropped when no response arrives', async () => {
    const server = serverAnswering(dropRequest)

    const failure = await Effect.runPromise(
      Effect.flip(smartClientFor(SESSION, server.transport).request('Patient'))
    )

    expect(failure).toBeInstanceOf(FhirRequestDropped)
    expect(failure).toMatchObject({ url: 'https://fhir.example/r4/Patient' })
  })

  test('fails with FhirResponseNotJson when a success carries no JSON', async () => {
    const server = serverAnswering(answerText('<html>'))

    const failure = await Effect.runPromise(
      Effect.flip(smartClientFor(SESSION, server.transport).request('Patient'))
    )

    expect(failure).toBeInstanceOf(FhirResponseNotJson)
    expect(failure).toMatchObject({ url: 'https://fhir.example/r4/Patient' })
  })
})
