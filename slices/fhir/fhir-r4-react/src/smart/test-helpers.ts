/**
 * A stub FHIR server for the tests of anything that reads through a
 * `SmartClient` or a SMART router context: an `HttpClient` transport that
 * answers each request by the longest URL prefix it matches and records what
 * was sent, so a test asserts what actually went on the wire.
 *
 * @packageDocumentation
 */
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest,
} from '@effect/platform'
import { Effect, Layer, Match } from 'effect'

import { requestTargetOf, smartClientFor, type SmartClient } from './smart-client.ts'
import { decodeFhirBaseUrl, type SmartConnection } from './smart-connection.ts'

/** The FHIR base a {@link stubSmartClient} is connected to, and relative keys resolve under. */
const STUB_FHIR_BASE = decodeFhirBaseUrl('https://fhir.example')

/** How the stub server answers one request it was sent. */
type StubAnswer = (
  request: HttpClientRequest.HttpClientRequest
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>

/**
 * The stub server's answers, keyed by URL prefix. An absolute key matches as
 * it is; a relative one (`Patient?`, `Patient/p1`) is a path under
 * {@link STUB_FHIR_BASE}.
 */
type StubAnswers = Readonly<Record<string, StubAnswer>>

/** A stub server's transport, and the record of what was sent through it. */
interface StubFhirServer {
  /** The transport to hand `smartClientFor` or `buildSmartRouterContext`. */
  readonly transport: Layer.Layer<HttpClient.HttpClient>
  /** Every request the transport was sent, in order, as sent. */
  readonly requests: readonly HttpClientRequest.HttpClientRequest[]
  /** The URL of each of {@link StubFhirServer.requests}. */
  readonly urls: readonly string[]
}

/** The absolute URL prefix the answer key `key` matches. */
const prefixOf = (key: string): string =>
  Match.value(requestTargetOf(key, STUB_FHIR_BASE)).pipe(
    Match.tag('Relative', ({ path }) => `${STUB_FHIR_BASE}/${path}`),
    Match.orElse(() => key)
  )

/**
 * A stub FHIR server answering from `answers`, the longest matching prefix
 * winning. A request no key matches dies: the test forgot an answer.
 */
const stubFhirServer = (answers: StubAnswers): StubFhirServer => {
  const requests: HttpClientRequest.HttpClientRequest[] = []
  const urls: string[] = []
  const prefixed = Object.entries(answers)
    .map(([key, answer]) => ({ prefix: prefixOf(key), answer }))
    .toSorted((left, right) => right.prefix.length - left.prefix.length)
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        requests.push(request)
        urls.push(request.url)
        const matched = prefixed.find(({ prefix }) => request.url.startsWith(prefix))
        return matched === undefined
          ? Effect.dieMessage(`unexpected request ${request.url}`)
          : matched.answer(request)
      })
    )
  )
  return { transport, requests, urls }
}

/**
 * A {@link SmartClient} on a {@link stubFhirServer} answering from `answers`,
 * connected to {@link STUB_FHIR_BASE} with no token and no launch patient
 * unless `connection` says otherwise.
 */
const stubSmartClient = (
  answers: StubAnswers,
  connection: Partial<SmartConnection> = {}
): StubFhirServer & { readonly client: SmartClient } => {
  const server = stubFhirServer(answers)
  const client = smartClientFor(
    { serverUrl: STUB_FHIR_BASE, accessToken: undefined, patient: undefined, ...connection },
    server.transport
  )
  return { ...server, client }
}

/** A {@link stubSmartClient} whose server answers every request with `body` as JSON. */
const smartClientAnswering = (body: unknown): ReturnType<typeof stubSmartClient> =>
  stubSmartClient(answerEveryRequest(answerJson(body)))

/** An answer of `status` (200 unless given) with `body` as JSON. */
const answerJson =
  (body: unknown, status = 200): StubAnswer =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })))

/** An answer of the error status `status`, with `body` as JSON when given. */
const answerStatus =
  (status: number, body?: unknown): StubAnswer =>
  (request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        body === undefined ? new Response(null, { status }) : Response.json(body, { status })
      )
    )

/** A success whose body is `text`, which is not JSON. */
const answerText =
  (text: string): StubAnswer =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(text)))

/** No response at all: the request is refused before it leaves, as a CORS block is. */
const dropRequest: StubAnswer = (request) =>
  Effect.fail(
    new HttpClientError.RequestError({
      request,
      reason: 'Transport',
      cause: new TypeError('Failed to fetch'),
    })
  )

/** A response that never arrives. */
const neverAnswer: StubAnswer = () => Effect.never

/**
 * Each call answered by the next of `answers`, the last one repeating: a
 * server that fails and then recovers. With no answers, every request dies.
 */
const answerInTurn = (...answers: readonly StubAnswer[]): StubAnswer => {
  let calls = 0
  return (request) => {
    const answer = answers[Math.min(calls, answers.length - 1)]
    calls += 1
    return answer === undefined ? Effect.dieMessage('answerInTurn has no answers') : answer(request)
  }
}

/** Answers that answer every request, wherever it goes, with `answer`. */
const answerEveryRequest = (answer: StubAnswer): StubAnswers => ({
  'https://': answer,
  'http://': answer,
})

/** A search-result bundle holding `resources`, pointing on to `nextUrl` when given. */
const bundleOf = (resources: readonly unknown[], nextUrl?: string): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: nextUrl === undefined ? [] : [{ relation: 'next', url: nextUrl }],
})

export {
  answerEveryRequest,
  answerInTurn,
  answerJson,
  answerStatus,
  answerText,
  bundleOf,
  dropRequest,
  neverAnswer,
  smartClientAnswering,
  STUB_FHIR_BASE,
  stubFhirServer,
  stubSmartClient,
  type StubAnswer,
  type StubAnswers,
  type StubFhirServer,
}
