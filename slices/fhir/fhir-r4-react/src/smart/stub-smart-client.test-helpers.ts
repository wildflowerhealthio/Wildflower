import { Effect, Option } from 'effect'

import type { FhirRequestError, SmartClient } from './smart-client.ts'

/**
 * The stub {@link SmartClient} the SMART readers' tests drive, and the record
 * of what they asked it for.
 */
interface StubSmartClient {
  /** The stub to hand a reader. */
  readonly client: SmartClient
  /** Every URL `request` was called with, in call order. */
  readonly queries: string[]
}

/**
 * A stub {@link SmartClient} whose `request` answers each call with the next of
 * `answers` (the last one repeating), recording the URL it was asked for.
 *
 * @param answers - What each `request` call yields: `{ success }` succeeds
 *   with its value, `{ failure }` fails with its error
 *
 * @remarks
 * This lives in its own module (rather than in one suite) because the
 * readers' suites all need the same stub, and the transport is the one seam
 * they assert against.
 */
const scriptedSmartClient = (
  answers: readonly ({ readonly success: unknown } | { readonly failure: FhirRequestError })[]
): StubSmartClient => {
  const queries: string[] = []
  const client: SmartClient = {
    serverUrl: 'https://fhir.example',
    accessToken: undefined,
    launchPatientId: Option.none(),
    request: (url) =>
      Effect.suspend(() => {
        const answer = answers[Math.min(queries.length, answers.length - 1)]
        queries.push(url)
        if (answer === undefined) return Effect.die(new Error(`unexpected request ${url}`))
        return 'failure' in answer ? Effect.fail(answer.failure) : Effect.succeed(answer.success)
      }),
  }
  return { client, queries }
}

/** A stub {@link SmartClient} whose every `request` succeeds with `response`. */
const stubSmartClient = (response: unknown): StubSmartClient =>
  scriptedSmartClient([{ success: response }])

export { scriptedSmartClient, stubSmartClient, type StubSmartClient }
