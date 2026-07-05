import { Equal, Hash } from 'effect'

export default abstract class Context implements Equal.Equal {
  abstract readonly kind: string

  /**
   * The value payload compared/hashed on top of `kind` (`''` for singleton
   * contexts) — lets the base own the Equal/Hash pair once, so leaves are
   * structurally comparable by (kind, key) without hand-rolling both symbols.
   */
  protected abstract equalityKey(): string

  [Hash.symbol](): number {
    return Hash.combine(Hash.string(this.kind))(Hash.string(this.equalityKey()))
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return (
      that instanceof Context &&
      that.kind === this.kind &&
      that.equalityKey() === this.equalityKey()
    )
  }

  abstract serialize(): string

  /**
   * Whether this context grants everything `other` does — the context half of scope
   * coverage (`spec.md §3`), mirroring `scopes-rust`'s `ContextLevel::covers`. For FHIR
   * contexts `system` covers everything while `user` and `patient` cover only themselves;
   * the Wildflower context is a singleton (covers only itself). A context never covers
   * one of another kind.
   */
  abstract covers(other: Context): boolean
}
