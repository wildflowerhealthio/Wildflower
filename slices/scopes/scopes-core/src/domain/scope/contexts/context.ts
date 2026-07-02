import { Equal, Hash } from 'effect'

export default abstract class Context implements Equal.Equal {
  abstract readonly kind: string;

  abstract [Hash.symbol](): number
  abstract [Equal.symbol](that: Equal.Equal): boolean

  abstract serialize(): string

  abstract supersetOf(other: Context): boolean
}
