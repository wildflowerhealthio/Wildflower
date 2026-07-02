/** The fixed context segment all Wildflower scopes share (`wildflower/...`). */

import { Equal, Hash } from 'effect'
import Context from './context'

class WildflowerContext extends Context {
  readonly kind: typeof WildflowerContext.kind = WildflowerContext.kind

  // oxlint-disable-next-line no-useless-constructor
  constructor() {
    super()
  }

  [Hash.symbol](): number {
    return Hash.string(this.kind)
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof WildflowerContext && this.kind === that.kind
  }

  serialize(): string {
    return 'wildflower'
  }

  supersetOf(other: Context): boolean {
    return other instanceof WildflowerContext
  }
}

// oxlint-disable import/group-exports
namespace WildflowerContext {
  export const kind = 'wildflower' as const

  export const parse = (s: string): WildflowerContext | null => {
    if (s === 'wildflower') return new WildflowerContext()

    return null
  }
}

export default WildflowerContext
