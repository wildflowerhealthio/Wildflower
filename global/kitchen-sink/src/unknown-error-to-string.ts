/**
 * Coerce an unknown thrown value into a human-readable string.
 *
 * @remarks
 * `catch` / mutation-error / promise-rejection values are typed `unknown`
 * because anything can be thrown. This is the canonical "show it to the
 * user" coercion every error-rendering call site was hand-rolling:
 *
 *   - an `Error` → its `message` (the common case — `new Error('boom')`
 *     renders as `"boom"`, not `"Error: boom"`);
 *   - anything else → `String(value)`.
 *
 * Deliberately shallow: it does not unwrap `cause`, stringify objects as
 * JSON, or special-case non-`Error` shapes. Call sites that need richer
 * formatting (e.g. decoding a typed error body) should branch before
 * falling back to this.
 */
const unknownErrorToString = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export { unknownErrorToString }
