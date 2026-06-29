/**
 * The fallback scope kind: anything the grammar doesn't recognize, preserved
 * verbatim so it round-trips unchanged. Mirrors `scopes-rust`'s `UnknownScope`
 * (`scope/unknown.rs`) — the total-parse fallback.
 *
 * Namespace module (`import { UnknownScope } from 'scopes-core'`): the value is
 * {@link UnknownScope}, with `UnknownScope.make`, `UnknownScope.scopeSerialize`.
 */

import type { ScopeSerializer } from '../behaviour/index.ts'

/** A scope string the grammar didn't recognize, kept verbatim. */
type UnknownScope = { readonly kind: 'unknown'; readonly raw: string }

/** Wrap a raw string as an unknown scope. */
const make = (raw: string): UnknownScope => ({ kind: 'unknown', raw })

/** Render an unknown scope — the raw string, unchanged. */
const scopeSerialize: ScopeSerializer<UnknownScope>['scopeSerialize'] = (scope) => scope.raw

export { type UnknownScope, make, scopeSerialize }
