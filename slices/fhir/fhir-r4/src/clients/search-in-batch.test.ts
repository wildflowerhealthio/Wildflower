import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Effect, Either, Layer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { literalReferenceOf } from '../resources/index.ts'
import { type BatchSearch, FhirR4ResourcesHttpApiClient, searchInBatch } from './index.ts'

describe('searchInBatch', () => {
  it('should send one POST / batch Bundle with a GET entry per search, its query encoded', async () => {
    // Arrange
    const searches: readonly BatchSearch[] = [
      { resourceType: 'Patient', urlParams: { family: "O'Brien & Sons", given: 'Ann Marie' } },
      { resourceType: 'Practitioner', urlParams: { name: 'Lee', _count: 2 } },
    ]

    // Act
    const { requests } = await runWith(searches, (body) =>
      batchResponse(body.entry.map(() => searchsetEntry([])))
    )

    // Assert
    expect(requests).toEqual([
      {
        method: 'POST',
        url: `${TEST_ORIGIN}/`,
        type: 'batch',
        entries: [
          { method: 'GET', url: 'Patient?family=O%27Brien+%26+Sons&given=Ann+Marie' },
          { method: 'GET', url: 'Practitioner?_count=2&name=Lee' },
        ],
      },
    ])
  })

  it('should give each search its own matches, in the order the searches were given', async () => {
    // Arrange
    const searches: readonly BatchSearch[] = [
      { resourceType: 'Patient', urlParams: { family: 'Smith' } },
      { resourceType: 'Patient', urlParams: { family: 'Jones' } },
      { resourceType: 'Practitioner', urlParams: { name: 'Lee' } },
    ]

    // Act
    const { result } = await runWith(searches, () =>
      batchResponse([
        searchsetEntry([stored('Patient', 's-1'), stored('Patient', 's-2')]),
        searchsetEntry([]),
        searchsetEntry([stored('Practitioner', 'l-1')]),
      ])
    )

    // Assert
    expect(result.map(Either.map((matches) => matches.map(literalReferenceOf)))).toEqual([
      Either.right(['Patient/s-1', 'Patient/s-2']),
      Either.right([]),
      Either.right(['Practitioner/l-1']),
    ])
  })

  it('should fail a search the server rejected at its position, its status and outcome with it, and keep the others', async () => {
    // Arrange
    const searches: readonly BatchSearch[] = [
      { resourceType: 'Patient', urlParams: { family: 'Smith' } },
      { resourceType: 'Patient', urlParams: { given: 'Ann' } },
    ]
    const outcome = {
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'invalid', diagnostics: 'unknown parameter' }],
    }

    // Act
    const { result } = await runWith(searches, () =>
      batchResponse([
        searchsetEntry([stored('Patient', 's-1')]),
        { response: { status: '400 Bad Request', outcome } },
      ])
    )

    // Assert
    expect(result[0]).toMatchObject({ _tag: 'Right', right: [{ id: 's-1' }] })
    expect(result[1]).toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'BatchSearchRejected',
        resourceType: 'Patient',
        status: '400 Bad Request',
        outcome: {
          issue: [{ severity: 'error', code: 'invalid', diagnostics: 'unknown parameter' }],
        },
      },
    })
  })

  it('should fail a search the response holds no entry for as unanswered', async () => {
    // Arrange
    const searches: readonly BatchSearch[] = [
      { resourceType: 'Patient', urlParams: { family: 'Smith' } },
      { resourceType: 'Goal', urlParams: { identifier: 'x' } },
    ]

    // Act
    const { result } = await runWith(searches, () => batchResponse([searchsetEntry([])]))

    // Assert
    expect(result[1]).toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'BatchSearchRejected',
        resourceType: 'Goal',
        status: 'No response',
        outcome: null,
      },
    })
  })

  it('should fail a search whose searchset holds a match without its resource', async () => {
    // Arrange
    const searches: readonly BatchSearch[] = [
      { resourceType: 'Practitioner', urlParams: { name: 'Lee' } },
    ]

    // Act
    const { result } = await runWith(searches, () =>
      batchResponse([
        {
          response: { status: '200 OK' },
          resource: searchset([{ search: { mode: 'match' } }]),
        },
      ])
    )

    // Assert
    expect(result[0]).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'MatchWithoutResource', resourceType: 'Practitioner' },
    })
  })

  it.each([
    {
      reason: 'a match without an id',
      resource: searchset([{ resource: { resourceType: 'Patient' } }]),
    },
    { reason: 'no searchset at all', resource: undefined },
  ])('should fail a search answered with $reason as undecodable', async ({ resource }) => {
    // Arrange
    const searches: readonly BatchSearch[] = [{ resourceType: 'Patient', urlParams: {} }]

    // Act
    const { result } = await runWith(searches, () =>
      batchResponse([{ response: { status: '200 OK' }, resource }])
    )

    // Assert
    expect(result[0]).toMatchObject({ _tag: 'Left', left: { _tag: 'ParseError' } })
  })

  it('should fail the whole call when the batch itself is refused', async () => {
    // Arrange
    const searches: readonly BatchSearch[] = [{ resourceType: 'Patient', urlParams: {} }]

    // Act
    const outcome = await Effect.runPromise(
      Effect.either(searchInBatch(searches)).pipe(
        Effect.provide(clientLayer([], () => new Response('', { status: 503 })))
      )
    )

    // Assert
    expect(Either.isLeft(outcome)).toBe(true)
  })

  it('should send nothing for no searches', async () => {
    const { requests, result } = await runWith([], () => batchResponse([]))

    expect({ requests, result }).toEqual({ requests: [], result: [] })
  })
})

// Helpers

const TEST_ORIGIN = 'http://fhir-r4.test'

interface RequestBundle {
  readonly type: string
  readonly entry: readonly { readonly request: { readonly method: string; readonly url: string } }[]
}

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly type: string
  readonly entries: readonly { readonly method: string; readonly url: string }[]
}

type Responder = (body: RequestBundle) => Response

const stored = (resourceType: string, id: string): object => ({ resourceType, id })

const searchset = (entries: readonly object[]): object => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: entries,
})

const searchsetEntry = (resources: readonly object[]): object => ({
  response: { status: '200 OK' },
  resource: searchset(resources.map((resource) => ({ resource, search: { mode: 'match' } }))),
})

const batchResponse = (entries: readonly object[]): Response =>
  new Response(JSON.stringify({ resourceType: 'Bundle', type: 'batch-response', entry: entries }), {
    status: 200,
    headers: { 'content-type': 'application/fhir+json' },
  })

/** The request's body as the bundle it was sent as; the test sends nothing else. */
const requestBundleOf = (raw: string): RequestBundle => {
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- the body this suite's own requests carry
  const parsed: RequestBundle = JSON.parse(raw)
  return parsed
}

const clientLayer = (
  records: RecordedRequest[],
  responder: Responder
): Layer.Layer<FhirR4ResourcesHttpApiClient> =>
  FhirR4ResourcesHttpApiClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.mapRequest(
          HttpClient.make((request) => {
            const raw =
              request.body._tag === 'Uint8Array'
                ? new TextDecoder().decode(request.body.body)
                : '{}'
            const body = requestBundleOf(raw)
            records.push({
              method: request.method,
              url: request.url,
              type: body.type,
              entries: body.entry.map(({ request: { method, url } }) => ({ method, url })),
            })
            return Effect.succeed(HttpClientResponse.fromWeb(request, responder(body)))
          }),
          HttpClientRequest.prependUrl(TEST_ORIGIN)
        )
      )
    )
  )

const runWith = async (
  searches: readonly BatchSearch[],
  responder: Responder
): Promise<{
  readonly requests: readonly RecordedRequest[]
  readonly result: Effect.Effect.Success<ReturnType<typeof searchInBatch>>
}> => {
  const records: RecordedRequest[] = []
  const result = await Effect.runPromise(
    searchInBatch(searches).pipe(Effect.provide(clientLayer(records, responder)))
  )
  return { requests: records, result }
}
