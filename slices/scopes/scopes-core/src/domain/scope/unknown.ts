/**
 * The fallback scope kind: anything the grammar doesn't recognize, preserved
 * verbatim so it round-trips unchanged. Mirrors `scopes-rust`'s `UnknownScope`
 * (`scope/unknown.rs`) — the total-parse fallback.
 *
 * Namespace module (`import { UnknownScope } from 'scopes-core'`): the value is
 * {@link UnknownScope}, with `UnknownScope.make`, `UnknownScope.scopeSerialize`.
 */

import { BaseScope } from './scope.ts'

/** A scope string the grammar didn't recognize, kept verbatim. */
class UnknownScope extends BaseScope {
  readonly kind = 'unknown' as const
  readonly raw: string

  constructor(raw: string) {
    super()
    this.raw = raw
  }

  serialize(): string {
    return this.raw
  }

  static parse(raw: string): UnknownScope {
    return new UnknownScope(raw)
  }
}

export default UnknownScope
