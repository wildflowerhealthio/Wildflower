import { Context } from 'effect'
import type { StringLiteralTypes } from './types/index.ts'
class Origin extends Context.Tag('Origin')<
  Origin,
  // The origin must end in an alphanumeric character, not a slash
  // We can guarantee this at the type system level
  `${string}${StringLiteralTypes.AlphanumericCharacter}`
>() {}

export { Origin }
