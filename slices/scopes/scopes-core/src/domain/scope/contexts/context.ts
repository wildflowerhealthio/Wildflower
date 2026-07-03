import { Equal, Hash } from 'effect'

export default abstract class Context implements Equal.Equal {
  abstract readonly kind: string;

  abstract [Hash.symbol](): number
  abstract [Equal.symbol](that: Equal.Equal): boolean

  abstract serialize(): string

  /**
   * Whether this context grants everything `other` does — the context half of scope
   * coverage (`spec.md §3`), mirroring `scopes-rust`'s `ContextLevel::covers`. FHIR
   * contexts are **hierarchical** (`system ⊇ user ⊇ patient`); the Wildflower context is
   * a singleton (covers only itself). A context never covers one of another kind.
   */
  abstract covers(other: Context): boolean
}
