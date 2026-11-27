import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Effect, Exit, Layer, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { literalReferenceOf } from '../resources/index.ts'
import { BatchReadRejected, FhirR4ResourcesHttpApiClient, readInBatch } from './index.ts'

describe('readInBatch', () => {
  it('should send one POST / batch Bundle with a GET entry per literal reference', async () => {
    // Arrange
    const references = ['Patient/p-1', 'Observation/o-1']

    // Act
    const { requests } = await runWith(references, () =>
      batchResponse([found('Patient', 'p-1'), notFound])
    )

    // Assert
    expect(requests).toEqual([
      {
        method: 'POST',
        url: `${TEST_ORIGIN}/`,
        type: 'batch',
        entries: [
          { method: 'GET', url: 'Patient/p-1' },
          { method: 'GET', url: 'Observation/o-1' },
        ],
      },
    ])
  })

  it('should give the resource stored under each, and nothing for a 404 or a 410, in order', async () => {
    // Arrange
    const references = ['Patient/p-1', 'Patient/p-2', 'Patient/p-3']

    // Act
    const { exit } = await runWith(references, () =>
      batchResponse([notFound, found('Patient', 'p-2'), { response: { status: '410 Gone' } }])
    )

    // Assert
    expect(Exit.map(exit, (stored) => stored.map(Option.map(literalReferenceOf)))).toEqual(
      Exit.succeed([Option.none(), Option.some('Patient/p-2'), Option.none()])
    )
  })

  it('should send nothing for no reads', async () => {
    // Arrange / Act
    const { requests, exit } = await runWith([], () => batchResponse([]))

    // Assert
    expect({ requests, exit }).toEqual({ requests: [], exit: Exit.succeed([]) })
  })

  it('should fail with the read the server answered with another failing status', async () => {
    // Arrange
    const references = ['Patient/p-1', 'Patient/p-2']

    // Act
    const { exit } = await runWith(references, () =>
      batchResponse([
        found('Patient', 'p-1'),
        { response: { status: '500 Internal Server Error' } },
      ])
    )

    // Assert
    expect(exit).toEqual(
      Exit.fail(
        new BatchReadRejected({
          literalReference: 'Patient/p-2',
          status: '500 Internal Server Error',
        })
      )
    )
  })
})

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

const found = (resourceType: string, id: string): object => ({
  response: { status: '200 OK' },
  resource: { resourceType, id },
})

const notFound: object = { response: { status: '404 Not Found' } }

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
  references: readonly string[],
  responder: Responder
): Promise<{
  readonly requests: readonly RecordedRequest[]
  readonly exit: Exit.Exit<Effect.Effect.Success<ReturnType<typeof readInBatch>>, unknown>
}> => {
  const records: RecordedRequest[] = []
  const exit = await Effect.runPromiseExit(
    readInBatch(references).pipe(Effect.provide(clientLayer(records, responder)))
  )
  return { requests: records, exit }
}
