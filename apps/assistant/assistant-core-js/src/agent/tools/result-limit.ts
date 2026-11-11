import { Effect } from 'effect'

import { refuse, type ToolCallRefused } from './refusal.ts'

/**
 * How large a read's result may be.
 *
 * @packageDocumentation
 */

/**
 * The most characters of JSON a read's result may hold. A larger one (a
 * document with its file inline, say) would not fit a request, and a kept
 * round is sent again with every later message.
 */
const MAX_RESULT_CHARACTERS = 400_000

/** `json`, a read's result, or refused when it is over {@link MAX_RESULT_CHARACTERS}. */
const withinResultLimit = (json: string): Effect.Effect<string, ToolCallRefused> =>
  json.length > MAX_RESULT_CHARACTERS
    ? refuse(
        `The result is too large to show (${String(json.length)} characters; the most is ${String(MAX_RESULT_CHARACTERS)}). Search with a smaller _count, or with _elements naming the fields you need, leaving out large ones such as a document's content.`
      )
    : Effect.succeed(json)

export { MAX_RESULT_CHARACTERS, withinResultLimit }
