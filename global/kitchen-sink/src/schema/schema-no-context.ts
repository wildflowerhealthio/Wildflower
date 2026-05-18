// oxlint-disable typescript/no-explicit-any
import type { Schema } from 'effect'
/**
 * Any schema, including `never`.
 */
export type AllNoContext =
  | Schema.Schema.AnyNoContext
  | Schema.Schema<any, never, never>
  | Schema.Schema<never, any, never>
  | Schema.Schema<never, never, never>
