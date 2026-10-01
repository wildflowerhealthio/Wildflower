import type { SmartClient } from './smart-client.ts'

/** The FHIR server behind a {@link stubSmartClient}: a response per request-URL prefix. */
type FhirResponses = Readonly<Record<string, () => Promise<unknown>>>

/** A request no entry in the table answers — a test that forgot a response. */
class UnexpectedRequestError extends Error {}

/**
 * A SMART client whose reads answer from `responses`, the longest matching
 * prefix winning, recording every URL it was asked for in `requests`.
 */
const stubSmartClient = (
  responses: FhirResponses
): { readonly client: SmartClient; readonly requests: readonly string[] } => {
  const requests: string[] = []
  const request = (url: string): Promise<unknown> => {
    requests.push(url)
    const prefix = Object.keys(responses)
      .filter((candidate) => url.startsWith(candidate))
      .toSorted((left, right) => right.length - left.length)[0]
    const respond = prefix === undefined ? undefined : responses[prefix]
    return respond === undefined
      ? Promise.reject(new UnexpectedRequestError(`unexpected request ${url}`))
      : respond()
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub: the reads touch only `request`
  return { client: { request } as unknown as SmartClient, requests }
}

/** A search-result bundle holding `resources`, pointing on to `nextUrl` when given. */
const bundleOf = (resources: readonly unknown[], nextUrl?: string): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: nextUrl === undefined ? [] : [{ relation: 'next', url: nextUrl }],
})

/** A response that resolves to `body`. */
const answer =
  (body: unknown): (() => Promise<unknown>) =>
  () =>
    Promise.resolve(body)

export { answer, bundleOf, type FhirResponses, stubSmartClient }
