/**
 * Returns `e.cause` when `e` is a non-null object with a `cause` property,
 * otherwise returns `e` unchanged. Useful for logging the underlying error
 * inside wrapped exceptions (e.g. `Error` objects with `cause`, Effect
 * `FiberFailure` or `Cause`-shaped values) without losing fidelity when the
 * value isn't wrapped at all.
 */
export const unwrapCause = (e: unknown): unknown =>
  typeof e === 'object' && e !== null && 'cause' in e ? e.cause : e
