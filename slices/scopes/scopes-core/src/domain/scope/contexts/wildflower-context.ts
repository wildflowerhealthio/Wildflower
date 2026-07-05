/** The fixed context segment all Wildflower scopes share (`wildflower/...`). */

import Context from './context'

class WildflowerContext extends Context {
  readonly kind: typeof WildflowerContext.kind = WildflowerContext.kind

  // oxlint-disable-next-line no-useless-constructor
  constructor() {
    super()
  }

  protected equalityKey(): string {
    return ''
  }

  serialize(): string {
    return 'wildflower'
  }

  /** The Wildflower context is a singleton — it covers only another Wildflower context. */
  covers(other: Context): boolean {
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
