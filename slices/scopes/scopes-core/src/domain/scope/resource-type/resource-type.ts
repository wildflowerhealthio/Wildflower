import { Hash, Equal } from 'effect'

abstract class BaseResourceType implements Equal.Equal {
  abstract readonly kind: string;

  abstract [Hash.symbol](): number

  abstract [Equal.symbol](that: Equal.Equal): boolean

  abstract serialize(): string

  abstract singularLabel(): string
  abstract pluralLabel(): string

  abstract supersetOf(other: BaseResourceType): boolean
}

export default BaseResourceType
