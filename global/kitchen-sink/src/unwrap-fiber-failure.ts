import { Cause, Runtime } from 'effect'

/**
 * Reach through a `FiberFailure` wrapper to the underlying error value.
 *
 * `Effect.runPromise` rejects with a `FiberFailure` — a JS `Error` that stores the
 * run's `Cause` under a unique-symbol-keyed property
 * (`Runtime.FiberFailureCauseId`), not a string-named field — so the only safe way
 * to detect and unwrap one from outside the Effect runtime is the
 * `Runtime.isFiberFailure` guard. This returns the first typed failure (an
 * expected error on the failure channel) or, failing that, the first defect (a
 * thrown / `die` value); a value that isn't a `FiberFailure` is returned unchanged.
 *
 * Use it at the boundary where an Effect run's rejection meets Promise-based code
 * (a TanStack Query `queryFn` / mutation, a DOM event handler) so the consumer can
 * inspect the real error — an `HttpClientError.ResponseError`, a tagged domain
 * error — rather than the opaque `FiberFailure`.
 */
const unwrapFiberFailure = (caught: unknown): unknown => {
  if (!Runtime.isFiberFailure(caught)) return caught
  const cause = caught[Runtime.FiberFailureCauseId]
  const failure = Cause.failureOption(cause)
  if (failure._tag === 'Some') return failure.value
  const die = Cause.dieOption(cause)
  if (die._tag === 'Some') return die.value
  return caught
}

export { unwrapFiberFailure }
