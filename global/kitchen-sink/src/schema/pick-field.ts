import { Schema } from 'effect'

/**
 * `Schema.pick`'s `Keys` generic can't be inferred from a curried call site
 * (`Schema.pick(field)(schema)` resolves `A`/`I` to `unknown` before `schema`
 * is seen), so this wrapper pins `A`/`I`/`Keys` explicitly from a single,
 * uncurried call that names one field.
 *
 * ```ts
 * import { Schema } from "effect"
 * import { pickField } from "kitchen-sink/schema"
 *
 * const Person = Schema.Struct({ name: Schema.String, age: Schema.Number })
 *
 * //      ┌─── Schema.Schema<{ readonly name: string }, { readonly name: string }>
 * //      ▼
 * const NameOnly = pickField(Person, "name")
 * ```
 */
export const pickField = <A, I, R, K extends keyof A & keyof I>(
  schema: Schema.Schema<A, I, R>,
  field: K
): Schema.Schema<Pick<A, K>, Pick<I, K>, R> => Schema.pick<A, I, [K]>(field)(schema)
