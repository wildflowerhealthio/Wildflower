import { Hash, Equal } from 'effect'

abstract class BaseResourceType implements Equal.Equal {
  abstract readonly kind: string

  /**
   * The value payload compared/hashed on top of `kind` (the resource name;
   * `'*'` for wildcards) — lets the base own the Equal/Hash pair once, so
   * leaves are structurally comparable by (kind, key) without hand-rolling
   * both symbols.
   */
  protected abstract equalityKey(): string

  [Hash.symbol](): number {
    return Hash.combine(Hash.string(this.kind))(Hash.string(this.equalityKey()))
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return (
      that instanceof BaseResourceType &&
      that.kind === this.kind &&
      that.equalityKey() === this.equalityKey()
    )
  }

  abstract serialize(): string

  abstract singularLabel(): string
  abstract pluralLabel(): string

  abstract supersetOf(other: BaseResourceType): boolean
}

export default BaseResourceType
