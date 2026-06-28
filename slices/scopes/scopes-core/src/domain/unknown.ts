/**
 * The fallback scope kind: anything the grammar doesn't recognize, preserved
 * verbatim so it round-trips unchanged. Mirrors `scopes-rust`'s `UnknownScope`
 * (`scope/unknown.rs`) — the total-parse fallback.
 *
 * Namespace module (`import { UnknownScope } from 'scopes-core'`): the value is
 * {@link Any}, with `UnknownScope.make`, `UnknownScope.serialize`.
 */

/** A scope string the grammar didn't recognize, kept verbatim. */
export type Any = { readonly kind: 'unknown'; readonly raw: string }

/** Wrap a raw string as an unknown scope. */
export const make = (raw: string): Any => ({ kind: 'unknown', raw })

/** Render an unknown scope — the raw string, unchanged. */
export const serialize = (scope: Any): string => scope.raw
