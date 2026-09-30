import { Schema } from 'effect'

/** A string with something other than whitespace in it — a title, a name, a label. */
const NonBlankString = Schema.String.pipe(
  Schema.filter((text) => text.trim().length > 0, {
    message: () => 'expected a non-blank string',
  })
)

export { NonBlankString }
