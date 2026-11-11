import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from '@effect/platform'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, Effect, Exit, FastCheck as fc, Layer, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { IdSchema } from '../data-types/index.ts'
import { ResourceWrite } from './index.ts'

/** A request as it went on the wire: method, URL, the headers a write sets, and body text. */
interface SentRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** The headers a write sets, as `request` carries them. */
const WRITE_HEADERS = ['accept', 'prefer', 'content-type', 'if-match'] as const

const writeHeadersOf = (
  request: HttpClientRequest.HttpClientRequest
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    WRITE_HEADERS.flatMap((name) => {
      const value = request.headers[name]
      return value === undefined ? [] : [[name, value]]
    })
  )

const bodyTextOf = (request: HttpClientRequest.HttpClientRequest): string =>
  request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''

/** The FHIR base the stub client addresses the writes' base-relative URLs under. */
const FHIR_BASE = 'https://fhir.example/r4/'

/**
 * An `HttpClient` under {@link FHIR_BASE} answering every request with
 * `answer`, recording each into `sent`.
 */
const serverAnswering = (
  sent: SentRequest[],
  answer: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.mapRequest(
      HttpClient.make((request) =>
        Effect.suspend(() => {
          sent.push({
            method: request.method,
            url: request.url,
            headers: writeHeadersOf(request),
            body: bodyTextOf(request),
          })
          return answer(request)
        })
      ),
      HttpClientRequest.prependUrl(FHIR_BASE)
    )
  )

/** An answer of `status` with `body` as JSON, or no body. */
const answer =
  (status: number, body?: unknown) =>
  (
    request: HttpClientRequest.HttpClientRequest
  ): Effect.Effect<HttpClientResponse.HttpClientResponse> =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        body === undefined ? new Response(null, { status }) : Response.json(body, { status })
      )
    )

const observation = {
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'Weight' },
  subject: { reference: 'Patient/p1' },
} as const

const stored = { ...observation, id: 'o1', meta: { versionId: '1' } }

describe('ResourceWrite.create', () => {
  it('should POST the resource as FHIR JSON to its type, asking for the stored record back', async () => {
    const sent: SentRequest[] = []
    const written = await Effect.runPromise(
      ResourceWrite.create({ resource: observation }).pipe(
        Effect.provide(serverAnswering(sent, answer(201, stored)))
      )
    )

    expect(written).toEqual({ record: stored, id: 'o1', versionId: Option.some('1') })
    expect(sent).toEqual([
      {
        method: 'POST',
        url: `${FHIR_BASE}Observation`,
        headers: {
          accept: 'application/json',
          prefer: 'return=representation',
          'content-type': 'application/fhir+json',
        },
        body: JSON.stringify(observation),
      },
    ])
  })

  it('should read a record with no versionId as unversioned', async () => {
    const written = await Effect.runPromise(
      ResourceWrite.create({ resource: observation }).pipe(
        Effect.provide(serverAnswering([], answer(201, { ...observation, id: 'o1' })))
      )
    )

    expect(written.versionId).toEqual(Option.none())
  })

  it.each([
    ['no body', answer(201)],
    ['a body without an id', answer(201, observation)],
  ])('should fail a success answer with %s as accepted but unreadable', async (_case, answered) => {
    const exit = await Effect.runPromiseExit(
      ResourceWrite.create({ resource: observation }).pipe(
        Effect.provide(serverAnswering([], answered))
      )
    )

    expect(exit).toEqual(
      Exit.fail(new ResourceWrite.Failed({ failure: { kind: 'accepted-unreadable', status: 201 } }))
    )
  })

  it('should fail an error status with what its OperationOutcome said', async () => {
    const exit = await Effect.runPromiseExit(
      ResourceWrite.create({ resource: observation }).pipe(
        Effect.provide(
          serverAnswering(
            [],
            answer(422, {
              resourceType: 'OperationOutcome',
              issue: [{ severity: 'error', code: 'invalid', diagnostics: 'status is required' }],
            })
          )
        )
      )
    )

    expect(exit).toEqual(
      Exit.fail(
        new ResourceWrite.Failed({
          failure: {
            kind: 'error-status',
            status: 422,
            outcomeText: Option.some('status is required'),
          },
        })
      )
    )
  })

  it('should fail a request that got no answer as unreachable', async () => {
    const exit = await Effect.runPromiseExit(
      ResourceWrite.create({ resource: observation }).pipe(
        Effect.provide(
          serverAnswering([], (request) =>
            Effect.fail(
              new HttpClientError.RequestError({ request, reason: 'Transport', cause: 'offline' })
            )
          )
        )
      )
    )

    expect(exit).toEqual(Exit.fail(new ResourceWrite.Failed({ failure: { kind: 'unreachable' } })))
  })
})

describe('ResourceWrite.update', () => {
  it('should read a stored record whose meta the stricter schemas would refuse', async () => {
    const changed = { ...observation, id: 'o1', status: 'amended' }
    const storedMeta = { versionId: '2', tag: [{ system: 'local-tags', code: 'x' }] }
    const written = await Effect.runPromise(
      ResourceWrite.update({ resource: changed, versionId: '1' }).pipe(
        Effect.provide(serverAnswering([], answer(200, { ...changed, meta: storedMeta })))
      )
    )

    expect(written.versionId).toEqual(Option.some('2'))
  })

  it('should PUT the resource to its type and id with If-Match naming the version as a weak tag', async () => {
    const sent: SentRequest[] = []
    const changed = { ...observation, id: 'o1', status: 'amended' }
    const written = await Effect.runPromise(
      ResourceWrite.update({ resource: changed, versionId: '1' }).pipe(
        Effect.provide(serverAnswering(sent, answer(200, { ...changed, meta: { versionId: '2' } })))
      )
    )

    expect(written.versionId).toEqual(Option.some('2'))
    expect(sent).toEqual([
      {
        method: 'PUT',
        url: `${FHIR_BASE}Observation/o1`,
        headers: {
          accept: 'application/json',
          prefer: 'return=representation',
          'content-type': 'application/fhir+json',
          'if-match': 'W/"1"',
        },
        body: JSON.stringify(changed),
      },
    ])
  })

  it('should name any version id as W/"<versionId>"', () =>
    fc.assert(
      fc.asyncProperty(Arbitrary.make(IdSchema), async (versionId) => {
        const sent: SentRequest[] = []
        await Effect.runPromise(
          ResourceWrite.update({ resource: stored, versionId }).pipe(
            Effect.provide(serverAnswering(sent, answer(200, stored)))
          )
        )
        expect(sent[0]?.headers['if-match']).toBe(`W/"${versionId}"`)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    ))

  it('should keep an id that is not a FHIR id to one path segment', async () => {
    const sent: SentRequest[] = []
    await Effect.runPromise(
      ResourceWrite.update({ resource: { ...stored, id: 'o1/_history/1?x' }, versionId: '1' }).pipe(
        Effect.provide(serverAnswering(sent, answer(200, stored)))
      )
    )

    expect(sent.map(({ url }) => url)).toEqual([`${FHIR_BASE}Observation/o1%2F_history%2F1%3Fx`])
  })

  it('should fail a 412 as the record having changed since that version', async () => {
    const exit = await Effect.runPromiseExit(
      ResourceWrite.update({ resource: stored, versionId: '1' }).pipe(
        Effect.provide(serverAnswering([], answer(412)))
      )
    )

    expect(exit).toEqual(
      Exit.fail(new ResourceWrite.Failed({ failure: { kind: 'precondition-failed' } }))
    )
  })
})
