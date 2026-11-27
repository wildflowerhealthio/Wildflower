/**
 * A difference: one top-level field where an incoming record says something
 * other than the record it merges into, the kept one.
 *
 * @packageDocumentation
 */
import { Data } from 'effect'

/**
 * One top-level field where the incoming record has a value that differs
 * from the kept record's: it fills a gap when the kept record has no value
 * for it, and overwrites one otherwise.
 *
 * @remarks
 * A difference names its field and carries no value: callers read the
 * values from the two records by field name.
 */
type Type = Data.TaggedEnum<{
  FillsGap: { readonly field: string }
  Overwrites: { readonly field: string }
}>

const { FillsGap, Overwrites, $is: is } = Data.taggedEnum<Type>()

export { FillsGap, is, Overwrites }
export type { Type }
