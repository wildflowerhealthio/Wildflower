import { Option, Schema } from 'effect'
import type { LazyArg } from 'effect/Function'

export const OptionAsOptional = <A, I>(
  s: Schema.Schema<A, I, never>
): Schema.optionalWith<
  Schema.Schema<Option.Option<A>, I | undefined>,
  { default: LazyArg<Option.Option<A>> }
> =>
  s.pipe(
    Schema.OptionFromUndefinedOr,
    Schema.optionalWith({ default: () => Option.none<A>() } as const)
  )
