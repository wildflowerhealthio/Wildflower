/** The FHIR scope-context level (`patient`/`user`/`system`) and its ordered list. */

import { Equal, Hash } from 'effect'
import Context from './context.ts'

/** A FHIR scope context for a context level. */
class FhirContext extends Context {
  readonly kind: 'fhir' = FhirContext.kind
  readonly context: FhirContext.Level

  constructor(context: FhirContext.Level) {
    super()
    this.context = context
  }

  [Hash.symbol](): number {
    return Hash.combine(Hash.string(this.kind))(Hash.string(this.context))
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof FhirContext && this.kind === that.kind && this.context === that.context
  }

  serialize(): string {
    return this.context
  }

  supersetOf(other: Context): boolean {
    if (!(other instanceof FhirContext)) return false
    if (this.context === 'system') return true
    if (this.context === 'user') return other.context === 'user' || other.context === 'patient'
    if (this.context === 'patient') return other.context === 'patient'

    return false
  }
}

// oxlint-disable import/group-exports
namespace FhirContext {
  export const kind = 'fhir' as const
  export type Level = 'patient' | 'user' | 'system'
  export namespace Level {
    export const all: readonly Level[] = ['patient', 'user', 'system']
    /**
     * The access level a FHIR resource scope is relative to. `user` currently grants
     * the same as `system`, but the three are modeled and compared **strictly** —
     * `user` never silently means `system`.
     */
    export const isContextLevel = (s: string): s is Level => (all as readonly string[]).includes(s)
  }

  export const parse = (s: string): FhirContext | null =>
    Level.isContextLevel(s) ? new FhirContext(s) : null
}

export default FhirContext
