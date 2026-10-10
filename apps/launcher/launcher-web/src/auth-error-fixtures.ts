import { HttpClientError, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Effect } from 'effect'

/**
 * Test fixtures shared by the auth-error suites (`auth-errors.test.ts`,
 * `query-client.test.ts`, `retry-policy.test.ts`): the two error *shapes* the
 * detectors key on and the `FiberFailure` wrapping a rejected `runAuthed`
 * surfaces. Kept in one place so every suite tests against the exact same
 * fixtures rather than its own near-copies.
 */

/**
 * A `ResponseError` carrying an empty body at `status` — the exact shape
 * `HttpApiClient`'s `statusOrElse` / a `filterStatusOk` produces for a
 * non-declared status, and the shape the 401/403 detection keys on.
 */
const responseErrorWithStatus = (status: number): HttpClientError.ResponseError => {
  const request = HttpClientRequest.get('/fixture')
  return new HttpClientError.ResponseError({
    request,
    response: HttpClientResponse.fromWeb(request, new Response(null, { status })),
    reason: 'StatusCode',
  })
}

/**
 * The value a rejected `runAuthed` (i.e. a TanStack Query `queryFn`) surfaces:
 * `Effect.runPromise` rejects with a `FiberFailure` wrapping the typed failure.
 * Reproduces that exact wrapping so the detectors are tested against what they
 * actually receive, not the bare error. Narrowed to `Error` (the `FiberFailure`
 * is one) so callers get its `Error`-typed shape without an unsafe assertion.
 */
const asFiberFailure = async (error: unknown): Promise<Error> => {
  try {
    await Effect.runPromise(Effect.fail(error))
    throw new Error('expected the effect to fail')
  } catch (caught) {
    if (caught instanceof Error) return caught
    throw new Error('expected a FiberFailure (Error) rejection', { cause: caught })
  }
}

/**
 * A decoded `403 InsufficientScope` body — the value a *declared* 403 surfaces
 * on the Effect failure channel (not a `ResponseError`).
 */
const insufficientScopeBody = {
  error: 'InsufficientScope',
  missingScopes: ['wildflower/Grant.d', 'system/*.rs'],
} as const

export { asFiberFailure, insufficientScopeBody, responseErrorWithStatus }
