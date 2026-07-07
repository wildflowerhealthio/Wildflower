/**
 * The fallback scope kind: anything the grammar doesn't recognize, preserved
 * verbatim so it round-trips unchanged. Mirrors `scopes-rust`'s `UnknownScope`
 * (`scope/unknown.rs`) — the total-parse fallback.
 *
 * Namespace module (`import { UnknownScope } from 'scopes-core'`): the value is
 * {@link UnknownScope}, with `UnknownScope.make`, `UnknownScope.scopeSerialize`.
 */

import { Equal, Hash } from 'effect'
import { BaseScope } from './scope.ts'

/**
 * A scope string the grammar didn't recognize, kept verbatim. Structurally comparable
 * by its `raw` string (like the {@link KnownScope} sibling) so two `UnknownScope`s of
 * the same string are {@link Equal.equals} — membership and dedupe compare by value,
 * not identity.
 */
class UnknownScope extends BaseScope implements Equal.Equal {
  readonly kind = 'unknown' as const
  readonly raw: string

  constructor(raw: string) {
    super()
    this.raw = raw
  }

  [Hash.symbol](): number {
    return Hash.combine(Hash.string(this.kind))(Hash.string(this.raw))
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof UnknownScope && this.kind === that.kind && this.raw === that.raw
  }

  serialize(): string {
    return this.raw
  }

  static parse(raw: string): UnknownScope {
    return new UnknownScope(raw)
  }
}

export default UnknownScope
