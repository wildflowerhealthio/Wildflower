import type Client from 'fhirclient/lib/Client'

/**
 * The stub {@link Client} the SMART readers' tests drive, and the record of what
 * they asked it for.
 */
interface StubSmartClient {
  /** The stub to hand a reader in place of a real fhirclient `Client`. */
  readonly client: Client
  /** Every query string `request` was called with, in call order. */
  readonly queries: string[]
}

/**
 * A stub fhirclient `Client` that records the query it was asked for and answers
 * with a fixed response.
 *
 * @param response - The value every `client.request` call resolves to
 * @returns The stub client and the mutable list of queries it received
 *
 * @remarks
 * Only `request` is exercised by the readers built on `fetchResourcePage`, so the
 * rest of the large `Client` surface is elided with a test-only cast. This lives
 * in its own module (rather than in one suite) because the readers' suites all
 * need the same stub, and the transport is the one seam they assert against.
 */
const stubSmartClient = (response: unknown): StubSmartClient => {
  const queries: string[] = []
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub, only `request` is exercised
  const client = {
    request: (query: string): Promise<unknown> => {
      queries.push(query)
      return Promise.resolve(response)
    },
  } as unknown as Client

  return { client, queries }
}

export { stubSmartClient, type StubSmartClient }
