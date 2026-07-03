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

  /**
   * Whether this context covers `other` — **hierarchical**, `system ⊇ user ⊇ patient`
   * (a broader launch context grants everything a narrower one does), mirroring
   * `scopes-rust`'s `ContextLevel::covers`. A non-FHIR context is never covered.
   */
  covers(other: Context): boolean {
    if (!(other instanceof FhirContext)) return false
    if (this.context === 'system') return true
    if (this.context === 'user') return other.context === 'user' || other.context === 'patient'
    return other.context === 'patient'
  }
}

// oxlint-disable import/group-exports
namespace FhirContext {
  export const kind = 'fhir' as const
  export type Level = 'patient' | 'user' | 'system'
  export namespace Level {
    export const all: readonly Level[] = ['patient', 'user', 'system']
    /**
     * The access level a FHIR resource scope is relative to. The three stay distinct
     * *values* (equality and serialization are exact — a `user` scope renders as `user`,
     * never silently `system`); only coverage ({@link FhirContext.covers}) applies the
     * `system ⊇ user ⊇ patient` order.
     */
    export const is = (s: string): s is Level => (all as readonly string[]).includes(s)
  }

  export const parse = (s: string): FhirContext | null => (Level.is(s) ? new FhirContext(s) : null)

  /** The three FHIR contexts as shared singletons — prefer these to the constructor. */
  export const patient = new FhirContext('patient')
  export const user = new FhirContext('user')
  export const system = new FhirContext('system')
}

export default FhirContext
