import { capitalize } from 'effect/String'
import type * as Datatype from './datatype.ts'

type Name<Prefix extends string, TName extends Datatype.Name> = `${Prefix}${Capitalize<TName>}`

const Name = <const Prefix extends string, const TName extends Datatype.Name>(
  prefix: Prefix,
  name: TName
): Name<Prefix, TName> => `${prefix}${capitalize(name)}` as const

/** Strip a literal `Prefix` off a key and uncapitalize the remainder. */
type DatatypeNameFromName<
  TChoiceElementName extends string,
  Prefix extends string,
> = TChoiceElementName extends `${Prefix}${infer Rest}` ? Uncapitalize<Rest> : never

export { Name, type DatatypeNameFromName }
