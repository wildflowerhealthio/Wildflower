import { Schema } from 'effect'
import type { LiteralValue } from 'effect/SchemaAST'

export const literalWithDefault = <
  Default extends LiteralValue,
  Others extends ReadonlyArray<LiteralValue>,
>(
  defaultValue: Default,
  ...otherValues: Others
): Schema.optionalWith<Schema.Literal<[Default, ...Others]>, { default: () => Default }> =>
  Schema.Literal(defaultValue, ...otherValues).pipe(
    Schema.optionalWith({
      default: (): Default => defaultValue,
    })
  )
