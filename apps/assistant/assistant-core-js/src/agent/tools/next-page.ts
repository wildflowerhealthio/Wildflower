import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Effect, Either, Encoding, Option, Schema } from 'effect'

import * as Chat from '../../chat.ts'
import { type FhirReadFailed, FhirRecords } from '../../fhir-records.ts'
import type * as ChatTools from './chat-tools.ts'
import { decodePageResult, pathUnderBaseOf, readPage, searchedTypeIfNamed } from './page.ts'
import { decodeInput, offeredTypeOf, ToolCallRefused } from './refusal.ts'
import { NEXT_PAGE, SEARCH_RECORDS } from './tool-names.ts'

/**
 * `next_page`: the page a `next` cursor a page in this chat gave points at.
 *
 * @packageDocumentation
 */

/** `next_page`'s input. */
const NextPageInput = Schema.Struct({ cursor: Schema.String })

const NEXT_PAGE_DEFINITION: BetaTool = {
  name: NEXT_PAGE,
  description:
    'Get the next page of a search: pass the "next" cursor a search_records or next_page result gave. The result has the same shape.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      cursor: { type: 'string', description: 'The "next" cursor, exactly as it was given.' },
    },
    required: ['cursor'],
    additionalProperties: false,
  },
}

const nextPage = (
  tools: ChatTools.Type,
  input: unknown,
  cursorsIssued: ReadonlySet<string>
): Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> =>
  Effect.gen(function* () {
    const { cursor } = yield* decodeInput(NextPageInput, input)
    const { fhirBaseUrl } = yield* FhirRecords
    const notACursor = new ToolCallRefused({
      reason: "That isn't a cursor a search gave. Search again with search_records.",
    })
    // Only a cursor a page in this chat gave is read: any other path would
    // skip the patient, the parameters and the page size a search is held to.
    if (!cursorsIssued.has(cursor)) return yield* Effect.fail(notACursor)
    const path = yield* Encoding.decodeBase64UrlString(cursor).pipe(
      Either.flatMap((decoded) =>
        Either.fromOption(pathUnderBaseOf({ url: decoded, fhirBaseUrl }), () => notACursor)
      ),
      Either.mapLeft(() => notACursor)
    )
    yield* Option.match(searchedTypeIfNamed(path), {
      onNone: () => Effect.void,
      onSome: (searchedType) => offeredTypeOf(tools.searchableTypes, searchedType),
    })
    return yield* readPage(tools, path)
  })

/**
 * The `next` cursors the chat's pages have given so far: the one in every
 * successful `search_records` or `next_page` result in `chat` that has one.
 * `next_page` reads no other.
 */
const cursorsIssuedIn = (chat: Chat.Type): ReadonlySet<string> =>
  new Set(
    chat.entries.flatMap((entry) => {
      if (entry._tag !== 'tool-round') return []
      const toolNameById = new Map(
        Chat.toolCallsOf(entry.message).map(({ id, name }) => [id, name] as const)
      )
      return entry.results.flatMap(({ tool_use_id, is_error, content }) => {
        const toolName = toolNameById.get(tool_use_id)
        return is_error !== true && (toolName === SEARCH_RECORDS || toolName === NEXT_PAGE)
          ? decodePageResult(content).pipe(
              Option.flatMapNullable(({ next }) => next),
              Option.toArray
            )
          : []
      })
    })
  )

export { cursorsIssuedIn, NEXT_PAGE_DEFINITION, nextPage, NextPageInput }
