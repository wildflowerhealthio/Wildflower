import type {
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Match, Option, Schema } from 'effect'

import * as Tools from './tools.ts'

/**
 * A tool call kept in a chat, in words for the transcript's card: one line
 * saying what the agent asked for, the parameters it gave, and how many
 * records came back. Nothing here repeats a record's contents.
 *
 * @remarks
 * A namespace module: `ToolCall.Call`, `ToolCall.summaryOf`,
 * `ToolCall.parametersOf`, `ToolCall.resultSummaryOf`.
 *
 * @packageDocumentation
 */

/** A tool call as a reply keeps it. */
type Call = Pick<BetaToolUseBlockParam, 'name' | 'input'>

/** One parameter of a call, as the card lists it. */
interface CallParameter {
  readonly name: string
  readonly value: string
}

const decodeSearch = Schema.decodeUnknownOption(Tools.SearchRecordsInput)
const decodeRead = Schema.decodeUnknownOption(Tools.ReadRecordInput)

/** The parameters `call` gave, as the card lists them; none for a cursor or no input. */
const parametersOf = (call: Call): readonly CallParameter[] =>
  Match.value(call.name).pipe(
    Match.when(Tools.SEARCH_RECORDS, () =>
      decodeSearch(call.input).pipe(
        Option.map(({ resourceType, params }) => [
          { name: 'resourceType', value: resourceType },
          ...params,
        ]),
        Option.getOrElse(() => [])
      )
    ),
    Match.when(Tools.READ_RECORD, () =>
      decodeRead(call.input).pipe(
        Option.map(({ resourceType, id }) => [
          { name: 'resourceType', value: resourceType },
          { name: 'id', value: id },
        ]),
        Option.getOrElse(() => [])
      )
    ),
    Match.orElse(() => [])
  )

/** What a search asked for, as `code=4548-4, up to 20`. */
const searchLineOf = (params: readonly CallParameter[]): string => {
  const count = params.find(({ name }) => name === '_count')?.value ?? String(Tools.DEFAULT_COUNT)
  const filters = params
    .filter(({ name }) => name !== '_count')
    .map(({ name, value }) => `${name}=${value}`)
  return [...filters, `up to ${count}`].join(', ')
}

/** One line saying what `call` asked for, such as "Searched Observation: code=4548-4, up to 20". */
const summaryOf = (call: Call): string =>
  Match.value(call.name).pipe(
    Match.when(Tools.SEARCH_RECORDS, () =>
      decodeSearch(call.input).pipe(
        Option.map(
          ({ resourceType, params }) => `Searched ${resourceType}: ${searchLineOf(params)}`
        ),
        Option.getOrElse(() => 'Searched the record')
      )
    ),
    Match.when(Tools.NEXT_PAGE, () => 'Read the next page of results'),
    Match.when(Tools.READ_RECORD, () =>
      decodeRead(call.input).pipe(
        Option.map(({ resourceType, id }) => `Read ${resourceType}/${id}`),
        Option.getOrElse(() => 'Read a record')
      )
    ),
    Match.when(Tools.CAPABILITIES, () => 'Checked what the server can search on'),
    Match.orElse((name) => `Called ${name}`)
  )

/** A tool result's JSON, as far as its count is read. */
const ResultCounts = Schema.parseJson(
  Schema.Struct({
    resources: Schema.optional(Schema.Array(Schema.Unknown)),
    more: Schema.optional(Schema.Boolean),
    resourceTypes: Schema.optional(Schema.Array(Schema.Unknown)),
  })
)

/** `count` of `noun`, pluralised by adding `s`. */
const countOf = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`

/**
 * How `result` came out for the call named `name`, in a few words: how many
 * records or types came back, "Failed", or "No result" when the call never
 * got one.
 */
const resultSummaryOf = (name: string, result: Option.Option<BetaToolResultBlockParam>): string =>
  Option.match(result, {
    onNone: () => 'No result',
    onSome: ({ is_error, content }) => {
      if (is_error === true) return 'Failed'
      const counts = Schema.decodeUnknownOption(ResultCounts)(content)
      return Match.value(name).pipe(
        Match.whenOr(Tools.SEARCH_RECORDS, Tools.NEXT_PAGE, () =>
          counts.pipe(
            Option.flatMap(({ resources, more }) =>
              Option.map(Option.fromNullable(resources), (found) =>
                more === true
                  ? `${countOf(found.length, 'record')}, more available`
                  : countOf(found.length, 'record')
              )
            ),
            Option.getOrElse(() => 'Done')
          )
        ),
        Match.when(Tools.READ_RECORD, () => '1 record'),
        Match.when(Tools.CAPABILITIES, () =>
          counts.pipe(
            Option.flatMap(({ resourceTypes }) => Option.fromNullable(resourceTypes)),
            Option.map((types) => countOf(types.length, 'record type')),
            Option.getOrElse(() => 'Done')
          )
        ),
        Match.orElse(() => 'Done')
      )
    },
  })

export { parametersOf, resultSummaryOf, summaryOf }
export type { Call, CallParameter }
