import {
  FhirHttpError,
  type FhirRequestError,
  type SmartClient,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { Effect, Option } from 'effect'

/** The FHIR server behind a {@link stubSmartClient}: a response per request-URL prefix. */
type FhirResponses = Readonly<
  Record<string, (url: string) => Effect.Effect<unknown, FhirRequestError>>
>

/**
 * A SMART client whose reads answer from `responses`, the longest matching
 * prefix winning, recording every URL it was asked for in `requests`. A
 * request no entry answers dies: the test forgot a response.
 */
const stubSmartClient = (
  responses: FhirResponses
): { readonly client: SmartClient; readonly requests: readonly string[] } => {
  const requests: string[] = []
  const request = (url: string): Effect.Effect<unknown, FhirRequestError> =>
    Effect.suspend(() => {
      requests.push(url)
      const prefix = Object.keys(responses)
        .filter((candidate) => url.startsWith(candidate))
        .toSorted((left, right) => right.length - left.length)[0]
      const respond = prefix === undefined ? undefined : responses[prefix]
      return respond === undefined ? Effect.dieMessage(`unexpected request ${url}`) : respond(url)
    })
  const client: SmartClient = {
    serverUrl: 'https://fhir.example',
    accessToken: undefined,
    launchPatientId: Option.none(),
    request,
  }
  return { client, requests }
}

/** A search-result bundle holding `resources`, pointing on to `nextUrl` when given. */
const bundleOf = (resources: readonly unknown[], nextUrl?: string): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: nextUrl === undefined ? [] : [{ relation: 'next', url: nextUrl }],
})

/** A response that succeeds with `body`. */
const answer =
  (body: unknown): (() => Effect.Effect<unknown>) =>
  () =>
    Effect.succeed(body)

/** A response the server answers with the error status `status`. */
const failWithStatus =
  (status: number): ((url: string) => Effect.Effect<never, FhirHttpError>) =>
  (url) =>
    Effect.fail(new FhirHttpError({ url, status }))

/** A response that never arrives. */
const neverAnswer = (): Effect.Effect<never> => Effect.never

export { answer, bundleOf, failWithStatus, type FhirResponses, neverAnswer, stubSmartClient }
