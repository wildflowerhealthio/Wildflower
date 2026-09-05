/**
 * Format an error's underlying details for display beneath its message —
 * the payload of {@link ErrorBanner}'s collapsible dropdown. Returns
 * `null` when there is nothing more to show than the message itself.
 *
 * @remarks
 * Wrapped errors (Effect's `FiberFailure`, an `Error` with a `.cause`) render
 * a short generic message but carry the real failure in `String(error)`
 * (subclass `.toString()` overrides pretty-print the underlying cause) or in
 * the `.cause` chain. Walking both surfaces the actual failure without a
 * per-shape special case.
 *
 * A shallow non-`Error` value returns `null`; its `String(...)` was already
 * shown as the message.
 */
const formatErrorDetails = (error: unknown): string | null => {
  if (error === null || error === undefined) return null
  if (!(error instanceof Error)) return null

  const parts: string[] = []
  const messageLine = `${error.name}: ${error.message}`
  const asString = String(error)
  // A subclass `.toString()` that pretty-prints beyond `Name: message`
  // (Effect `FiberFailure`, aggregate errors) is the real failure.
  if (asString !== messageLine && asString !== error.message) parts.push(asString)
  if (error.stack !== undefined && error.stack !== '') parts.push(error.stack)

  const seen = new Set<unknown>([error])
  let cause: unknown = (error as { readonly cause?: unknown }).cause
  while (cause !== undefined && cause !== null && !seen.has(cause)) {
    seen.add(cause)
    if (cause instanceof Error) {
      const line = `caused by ${cause.name}: ${cause.message}`
      parts.push(cause.stack !== undefined && cause.stack !== '' ? `${line}\n${cause.stack}` : line)
      cause = (cause as { readonly cause?: unknown }).cause
    } else {
      parts.push(`caused by ${stringifyForeign(cause)}`)
      cause = undefined
    }
  }

  return parts.length === 0 ? null : parts.join('\n\n')
}

/**
 * Render a non-`Error` cause so a bare object does not degrade to
 * `[object Object]`. Primitives keep their `String(...)`; objects go
 * through `JSON.stringify` with a fall-through when serialisation itself
 * fails (a `BigInt`, a cycle).
 */
const stringifyForeign = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return String(value)
  try {
    return JSON.stringify(value) ?? '[unserialisable]'
  } catch {
    return '[unserialisable]'
  }
}

export { formatErrorDetails }
