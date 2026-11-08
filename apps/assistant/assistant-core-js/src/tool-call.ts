import type {
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Match, Option, Predicate, Schema } from 'effect'

import { countOf } from './internal/count-of.ts'
import * as Tools from './tools.ts'

/**
 * A tool call kept in a chat, in words for the transcript's card: one line
 * saying what the agent asked for, the parameters it gave, and how many
 * records came back or how a write came out. Nothing here repeats a
 * record's contents.
 *
 * @remarks
 * A namespace module: `ToolCall.Call`, `ToolCall.summaryOf`,
 * `ToolCall.parametersOf`, `ToolCall.resultSummaryOf`, `ToolCall.lineOf`.
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
const decodeWrite = Schema.decodeUnknownOption(Tools.WriteRecordInput)

/** The record a write call names: its type, and its id when it gives one. */
const writtenRecordOf = (
  call: Call
): Option.Option<{ readonly resourceType: string; readonly id: Option.Option<string> }> =>
  decodeWrite(call.input).pipe(
    Option.map(({ resource }) => ({
      resourceType: resource.resourceType,
      id: Option.liftPredicate(resource['id'], Predicate.isString),
    }))
  )

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
    Match.whenOr(Tools.CREATE_RECORD, Tools.UPDATE_RECORD, () =>
      writtenRecordOf(call).pipe(
        Option.map(({ resourceType, id }) => [
          { name: 'resourceType', value: resourceType },
          ...Option.match(id, { onNone: () => [], onSome: (value) => [{ name: 'id', value }] }),
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
    Match.when(Tools.CREATE_RECORD, () =>
      writtenRecordOf(call).pipe(
        Option.map(({ resourceType }) => `Create ${resourceType}`),
        Option.getOrElse(() => 'Create a record')
      )
    ),
    Match.when(Tools.UPDATE_RECORD, () =>
      writtenRecordOf(call).pipe(
        Option.map(({ resourceType, id }) =>
          Option.match(id, {
            onNone: () => `Update ${resourceType}`,
            onSome: (recordId) => `Update ${resourceType}/${recordId}`,
          })
        ),
        Option.getOrElse(() => 'Update a record')
      )
    ),
    Match.orElse((name) => `Called ${name}`)
  )

const decodePage = Schema.decodeUnknownOption(Tools.PageResult)
const decodeCapabilities = Schema.decodeUnknownOption(Tools.CapabilitiesResult)
const decodeWritten = Schema.decodeUnknownOption(Tools.WriteRecordResult)

/**
 * How a write that wasn't saved came out, by how its result text opens:
 * declined, a record that changed since it was read, an answer that
 * couldn't be read, or any other failure.
 */
const unsavedWriteSummaryOf = (content: BetaToolResultBlockParam['content']): string => {
  const text = Predicate.isString(content) ? content : ''
  if (text.startsWith(Tools.DECLINED_TEXT)) return 'Declined'
  if (text.startsWith(Tools.STALE_RECORD_TEXT))
    return 'Failed: the record changed since it was read'
  if (text.startsWith(Tools.ACCEPTED_UNREADABLE_OPENING)) {
    return "Failed: probably saved, but the server's answer couldn't be read"
  }
  return 'Failed: not saved'
}

/** "Created Observation/123" or "Updated Observation/123", for the successful write result `content`. */
const savedWriteSummaryOf = (verb: string, content: BetaToolResultBlockParam['content']): string =>
  decodeWritten(content).pipe(
    Option.map(({ resourceType, id }) => `${verb} ${resourceType}/${id}`),
    Option.getOrElse(() => verb)
  )

/**
 * How `result` came out for the call named `name`, in a few words: how many
 * records or types came back, the record a write saved ("Created
 * Observation/123"), "Declined", "Failed" (for a write, why: "Failed: not
 * saved"), or "No result" when the call never got one.
 */
const resultSummaryOf = (name: string, result: Option.Option<BetaToolResultBlockParam>): string =>
  Option.match(result, {
    onNone: () => 'No result',
    onSome: ({ is_error, content }) => {
      if (is_error === true) {
        return Tools.isWriteCall({ name }) ? unsavedWriteSummaryOf(content) : 'Failed'
      }
      return Match.value(name).pipe(
        Match.whenOr(Tools.SEARCH_RECORDS, Tools.NEXT_PAGE, () =>
          decodePage(content).pipe(
            Option.map(({ resources, more }) =>
              more
                ? `${countOf(resources.length, 'record')}, more available`
                : countOf(resources.length, 'record')
            ),
            Option.getOrElse(() => 'Done')
          )
        ),
        Match.when(Tools.READ_RECORD, () => '1 record'),
        Match.when(Tools.CREATE_RECORD, () => savedWriteSummaryOf('Created', content)),
        Match.when(Tools.UPDATE_RECORD, () => savedWriteSummaryOf('Updated', content)),
        Match.when(Tools.CAPABILITIES, () =>
          decodeCapabilities(content).pipe(
            Option.map(({ resourceTypes }) => countOf(resourceTypes.length, 'record type')),
            Option.getOrElse(() => 'Done')
          )
        ),
        Match.orElse(() => 'Done')
      )
    },
  })

/**
 * The card's one line for `call`: what a read looked up ({@link summaryOf});
 * for a write, what it asked for and how it came out, so the outcome shows
 * without opening the card ("Update Observation/o1: Declined").
 */
const lineOf = (call: Call, result: Option.Option<BetaToolResultBlockParam>): string =>
  Tools.isWriteCall(call)
    ? `${summaryOf(call)}: ${resultSummaryOf(call.name, result)}`
    : summaryOf(call)

export { lineOf, parametersOf, resultSummaryOf, summaryOf }
export type { Call, CallParameter }
