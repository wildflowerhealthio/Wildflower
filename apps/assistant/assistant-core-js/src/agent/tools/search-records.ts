import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Effect, Either, Match, Option, Schema } from 'effect'

import * as ChatPatient from '../../chat-patient.ts'
import type { FhirReadFailed, FhirRecords } from '../../fhir-records.ts'
import * as SearchParam from '../../search-param.ts'
import * as PatientPin from '../patient-pin.ts'
import type * as ChatTools from './chat-tools.ts'
import { enumOf } from './json-schema.ts'
import { readPage } from './page.ts'
import { decodeInput, offeredTypeOf, refuse, ToolCallRefused } from './refusal.ts'
import { SEARCH_RECORDS } from './tool-names.ts'

/**
 * `search_records`: one page of a search, `_count` 20 unless the agent asks
 * for up to {@link MAX_COUNT}, pinned to the chat's patient in a chat about
 * one.
 *
 * @packageDocumentation
 */

/** The page size a search asks for unless the agent sets `_count`. */
const DEFAULT_COUNT = 20

/** The most a search may ask for in one page. */
const MAX_COUNT = 50

/** `search_records`' input. */
const SearchRecordsInput = Schema.Struct({
  resourceType: Schema.String,
  params: Schema.Array(SearchParam.Schema),
})

/** What each description says of the patient the tools are kept to. */
const patientNoteOf = (patient: ChatPatient.Type): string =>
  Match.value(patient).pipe(
    Match.when(
      { kind: 'patient' },
      () =>
        " This chat is about one patient, and the tool keeps every search to their records: it sets the patient, subject or _id parameter itself, so don't set those."
    ),
    Match.when({ kind: 'all-patients' }, () => ' The search covers every patient on the server.'),
    Match.exhaustive
  )

const searchRecordsDefinition = (
  patient: ChatPatient.Type,
  searchableTypes: readonly ResourceType.Type[]
): BetaTool => ({
  name: SEARCH_RECORDS,
  description:
    `Search the FHIR server for records of one type, with FHIR search parameters, and get one page of results as JSON: "resources", "total" when the server knows it, and "more": true with a "next" cursor for next_page when there are more. A page holds ${String(DEFAULT_COUNT)} records unless you set _count, up to ${String(MAX_COUNT)}. Use _sort (such as -date) to get the most recent first.` +
    patientNoteOf(patient),
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      resourceType: enumOf(searchableTypes, 'The FHIR resource type to search.'),
      params: {
        type: 'array',
        description:
          'FHIR search parameters, each a name (with any modifier or chain, such as code:text) and a value, such as {"name": "code", "value": "http://loinc.org|4548-4"}.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The search parameter name.' },
            value: { type: 'string', description: 'The search parameter value.' },
          },
          required: ['name', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['resourceType', 'params'],
    additionalProperties: false,
  },
})

/** A `_count` the agent may set: a whole number of at least 1. */
const AskedPageSize = Schema.NumberFromString.pipe(Schema.int(), Schema.positive())

/**
 * The page size `params` ask for with their first `_count`, held to
 * {@link MAX_COUNT}; {@link DEFAULT_COUNT} when they set none.
 */
const pageSizeOf = (params: readonly SearchParam.Type[]): Effect.Effect<number, ToolCallRefused> =>
  Array.findFirst(params, ({ name }) => name === '_count').pipe(
    Option.match({
      onNone: () => Effect.succeed(DEFAULT_COUNT),
      onSome: ({ value }) =>
        Schema.decode(AskedPageSize)(value).pipe(
          Effect.mapBoth({
            onFailure: () =>
              new ToolCallRefused({ reason: '_count must be a whole number of at least 1.' }),
            onSuccess: (asked) => Math.min(asked, MAX_COUNT),
          })
        ),
    })
  )

const isSearchParamName = Schema.is(SearchParam.Name)

const searchRecords = (
  tools: ChatTools.Type,
  input: unknown
): Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> =>
  Effect.gen(function* () {
    const { resourceType, params } = yield* decodeInput(SearchRecordsInput, input)
    const searchedType = yield* offeredTypeOf(tools.searchableTypes, resourceType)
    yield* Array.findFirst(params, ({ name }) => !isSearchParamName(name)).pipe(
      Option.match({
        onNone: () => Effect.void,
        onSome: ({ name }) => refuse(`"${name}" isn't a search parameter name.`),
      })
    )
    const pageSize = yield* pageSizeOf(params)
    const paramsWithoutCount = params.filter(({ name }) => name !== '_count')
    const pinnedParams = yield* Option.match(ChatPatient.patientIdIfOne(tools.patient), {
      onNone: () => Effect.succeed(paramsWithoutCount),
      onSome: (patientId) =>
        PatientPin.of(searchedType).pipe(
          Option.match({
            onNone: () => refuse(`${searchedType} can't be kept to one patient.`),
            onSome: (pin) =>
              Either.match(PatientPin.pinnedParamsOf(pin, patientId, paramsWithoutCount), {
                onLeft: ({ name }) =>
                  refuse(
                    `The ${name} parameter isn't allowed: this chat is about one patient, and the tool sets whose records to search itself.`
                  ),
                onRight: Effect.succeed,
              }),
          })
        ),
    })
    const query = new URLSearchParams([
      ...pinnedParams.map(({ name, value }): [string, string] => [name, value]),
      ['_count', String(pageSize)],
    ])
    return yield* readPage(tools, `${searchedType}?${query.toString()}`)
  })

export { DEFAULT_COUNT, MAX_COUNT, searchRecords, searchRecordsDefinition, SearchRecordsInput }
