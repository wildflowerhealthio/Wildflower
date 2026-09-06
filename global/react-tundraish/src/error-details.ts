/**
 * Format an error's underlying details for display beneath its message —
 * the payload of {@link ErrorBanner}'s collapsible dropdown. Returns
 * `null` when there is nothing more to show than the message itself.
 *
 * @remarks
 * Wrapped errors carry their real failure somewhere other than `.message`:
 *
 * - Effect's `FiberFailure`/`Cause` and any error implementing the standard
 *   `toJSON()` protocol expose the underlying failure through the JSON —
 *   for a `FiberFailure` wrapping a `Data.TaggedError` that is where the
 *   tagged fields (`shape`, `attempts`, …) live, since the FiberFailure
 *   itself only carries a generic `.message`;
 * - a `Data.TaggedError` thrown directly puts those same fields on the
 *   instance as own enumerable properties;
 * - an aggregate error / a subclass with a custom `.toString()` prints
 *   more than `Name: message`;
 * - an `Error` with a `.cause` links to the underlying failure.
 *
 * We consult all four, in that order, and join whatever is available.
 *
 * A shallow non-`Error` value returns `null`; its `String(...)` was already
 * shown as the message.
 */
const formatErrorDetails = (error: unknown): string | null => {
  if (error === null || error === undefined) return null
  if (!(error instanceof Error)) return null

  const parts: string[] = []

  // The public unwrap for anything that implements `toJSON` — Effect's
  // `FiberFailure` returns `{_id, cause: {_id, _tag, failure: <the wrapped
  // tagged error>}}`, so a caller sees the actual `PseudonymSpaceExhausted`
  // fields it never had a chance to see on the wrapper itself.
  const asJson = formatJson(error)
  if (asJson !== null) parts.push(asJson)

  const messageLine = `${error.name}: ${error.message}`
  const asString = String(error)
  // A subclass `.toString()` that pretty-prints beyond `Name: message`
  // (aggregate errors) is the real failure. `FiberFailure`'s `.toString()`
  // is name+message+stack — redundant with the JSON above and the stack
  // below — so skip it once we already used `toJSON`.
  if (asString !== messageLine && asString !== error.message && asJson === null) {
    parts.push(asString)
  }

  // A `Data.TaggedError` thrown directly (not through `runPromise`) exposes
  // its data as own enumerable properties; surface them when `toJSON` did
  // not already.
  if (asJson === null) {
    const ownFields = formatOwnFields(error)
    if (ownFields !== null) parts.push(ownFields)
  }

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

/** Property names the plain `Error` surface already covers, so they don't repeat as "own fields". */
const INTRINSIC_ERROR_KEYS = new Set(['name', 'message', 'stack', 'cause'])

/**
 * Call the error's own `toJSON` (the protocol Effect's `FiberFailure` and
 * `Cause` implement) and pretty-print it. Returns `null` when the error
 * has no `toJSON`, or the result serialises to `{}`/is empty — so a
 * plain `Error` (no `toJSON`) falls through to the own-fields pass and
 * doesn't render an empty JSON block.
 */
const formatJson = (error: Error): string | null => {
  const toJson: unknown = Reflect.get(error, 'toJSON')
  if (typeof toJson !== 'function') return null
  let payload: unknown
  try {
    payload = Reflect.apply(toJson, error, [])
  } catch {
    return null
  }
  if (payload === undefined || payload === null) return null
  try {
    const serialised = JSON.stringify(payload, null, 2)
    if (serialised === undefined || serialised === '{}' || serialised === '') return null
    return serialised
  } catch {
    return null
  }
}

/**
 * Any enumerable own properties on `error` that aren't the intrinsic
 * `Error` fields, JSON-stringified. Where an `Data.TaggedError` thrown
 * directly puts its payload (`shape`, `attempts`, …).
 */
const formatOwnFields = (error: Error): string | null => {
  const fields: Record<string, unknown> = {}
  for (const key of Object.keys(error)) {
    if (INTRINSIC_ERROR_KEYS.has(key)) continue
    fields[key] = Reflect.get(error, key)
  }
  if (Object.keys(fields).length === 0) return null
  try {
    return JSON.stringify(fields, null, 2)
  } catch {
    return null
  }
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
