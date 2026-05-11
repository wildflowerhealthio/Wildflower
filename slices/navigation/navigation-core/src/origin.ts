import { Context } from 'effect'
import type { StringLiteralTypes } from 'kitchen-sink/types'

/** Origin URL ending in an alphanumeric character (not a trailing slash). */
class Origin extends Context.Tag('Origin')<
  Origin,
  `${string}${StringLiteralTypes.AlphanumericCharacter}`
>() {}

export { Origin }
