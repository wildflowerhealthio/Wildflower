import type {
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { IdSchema } from '@wildflowerhealthio/fhir-r4/data-types'
import type { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Data, Effect, Encoding, Either, Match, Option, Schema } from 'effect'

import type * as ChatPatient from './chat-patient.ts'
import { type FhirReadFailed, FhirRecords } from './fhir-records.ts'
import * as PatientPin from './patient-pin.ts'
import * as RecordAccess from './record-access.ts'

/**
 * The tools a chat offers the agent, built from the grant and the patient
 * choice and fixed for the chat, so every request sends the same `tools` and
 * the prompt cache holds; and how a call to one runs against the FHIR
 * server.
 *
 * @remarks
 * A namespace module: `Tools.Type`, `Tools.make`, `Tools.run`, the tool
 * names, and the input schemas each call is decoded through before it runs.
 *
 * - `search_records` — one page of a search, `_count` 20 unless the agent
 *   asks for up to {@link MAX_COUNT}; with `more` and an opaque `next` cursor
 *   when there is another page.
 * - `next_page` — the page a `next` cursor points at.
 * - `read_record` — one record by type and id.
 * - `capabilities` — what the server says it can search on, for the types
 *   the chat offers.
 *
 * In a chat about one patient, each search is pinned to them
 * ({@link PatientPin}) and every record read back is checked to be theirs;
 * a type nothing pins is not offered. A failed call is a tool result with
 * `is_error: true` saying why, the server's `OperationOutcome` text included.
 *
 * @packageDocumentation
 */

const SEARCH_RECORDS = 'search_records'
const NEXT_PAGE = 'next_page'
const READ_RECORD = 'read_record'
const CAPABILITIES = 'capabilities'

/** The page size a search asks for unless the agent sets `_count`. */
const DEFAULT_COUNT = 20

/** The most a search may ask for in one page. */
const MAX_COUNT = 50

/** One search parameter, as the agent gives it. */
const SearchParamSchema = Schema.Struct({ name: Schema.String, value: Schema.String })

/** `search_records`' input. */
const SearchRecordsInput = Schema.Struct({
  resourceType: Schema.String,
  params: Schema.Array(SearchParamSchema),
})

/** `next_page`'s input. */
const NextPageInput = Schema.Struct({ cursor: Schema.String })

/** `read_record`'s input. */
const ReadRecordInput = Schema.Struct({ resourceType: Schema.String, id: Schema.String })

/** `capabilities`' input: nothing. */
const CapabilitiesInput = Schema.Struct({})

/** The tools of one chat, and what they were built from. */
interface Type {
  readonly patient: ChatPatient.Type
  /** The types `search_records` offers, in R4's order; empty when it is not offered. */
  readonly searchableTypes: readonly ResourceType.Type[]
  /** The types `read_record` offers, in R4's order; empty when it is not offered. */
  readonly readableTypes: readonly ResourceType.Type[]
  /** The tool definitions every request of the chat sends. */
  readonly definitions: readonly BetaTool[]
}

/** The JSON Schema of a string that is one of `values`. */
const enumOf = (values: readonly string[], description: string): Record<string, unknown> => ({
  type: 'string',
  enum: values,
  description,
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

const readRecordDefinition = (
  patient: ChatPatient.Type,
  readableTypes: readonly ResourceType.Type[]
): BetaTool => ({
  name: READ_RECORD,
  description:
    'Read one record from the FHIR server by its type and id, such as the Practitioner a reference like "Practitioner/123" points at. The result is the record as JSON.' +
    (patient.kind === 'patient'
      ? " This chat is about one patient: a record about another patient isn't returned."
      : ''),
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      resourceType: enumOf(readableTypes, "The record's FHIR resource type."),
      id: { type: 'string', description: "The record's id." },
    },
    required: ['resourceType', 'id'],
    additionalProperties: false,
  },
})

const CAPABILITIES_DEFINITION: BetaTool = {
  name: CAPABILITIES,
  description:
    "Find out what the FHIR server can search on: for each record type you can search, the search parameters the server's CapabilityStatement lists.",
  strict: true,
  input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
}

/** The types `resourceTypes` covers that a chat about `patient` can keep to them. */
const offeredTypesOf = (
  resourceTypes: RecordAccess.ResourceTypes,
  patient: ChatPatient.Type
): readonly ResourceType.Type[] =>
  RecordAccess.typesOf(resourceTypes).filter(
    (resourceType) => patient.kind === 'all-patients' || Option.isSome(PatientPin.of(resourceType))
  )

/**
 * The tools for a chat about `patient` under `access`: searching (with
 * `next_page` and `capabilities`) when some type can be searched, reading
 * by id when some type can be read, each offering only those types.
 */
const make = ({
  access,
  patient,
}: {
  readonly access: RecordAccess.Type
  readonly patient: ChatPatient.Type
}): Type => {
  const searchableTypes = offeredTypesOf(access.searchable, patient)
  const readableTypes = offeredTypesOf(access.readable, patient)
  return {
    patient,
    searchableTypes,
    readableTypes,
    definitions: [
      ...(searchableTypes.length > 0
        ? [
            searchRecordsDefinition(patient, searchableTypes),
            NEXT_PAGE_DEFINITION,
            CAPABILITIES_DEFINITION,
          ]
        : []),
      ...(readableTypes.length > 0 ? [readRecordDefinition(patient, readableTypes)] : []),
    ],
  }
}

/** A call the tool would not make, and why, in words for the agent. */
class ToolCallRefused extends Data.TaggedClass('ToolCallRefused')<{ readonly reason: string }> {}

const refuse = (reason: string): Effect.Effect<never, ToolCallRefused> =>
  Effect.fail(new ToolCallRefused({ reason }))

/** `input` decoded through `schema`, refusing anything else, extra properties included. */
const decodeInput = <A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown
): Effect.Effect<A, ToolCallRefused> =>
  Schema.decodeUnknown(schema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      () => new ToolCallRefused({ reason: "The input doesn't match the tool's input schema." })
    )
  )

/** `resourceType` as one of `offered`, or refused naming the tool's types. */
const offeredTypeOf = (
  offered: readonly ResourceType.Type[],
  resourceType: string
): Effect.Effect<ResourceType.Type, ToolCallRefused> =>
  Array.findFirst(offered, (each) => each === resourceType).pipe(
    Option.match({
      onNone: () => refuse(`${resourceType} isn't one of the record types this tool can reach.`),
      onSome: Effect.succeed,
    })
  )

/** A search parameter name: letters, digits, `_`, `-`, and `:` or `.` for modifiers and chains. */
const SEARCH_PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_\-:.]*$/u

/** The page size `params` asks for, and the parameters without `_count`. */
const pageSizeOf = (
  params: readonly PatientPin.SearchParam[]
): Effect.Effect<
  { readonly count: number; readonly params: readonly PatientPin.SearchParam[] },
  ToolCallRefused
> => {
  const [otherParams, countParams] = Array.partition(params, ({ name }) => name === '_count')
  return Array.head(countParams).pipe(
    Option.match({
      onNone: () => Effect.succeed({ count: DEFAULT_COUNT, params: otherParams }),
      onSome: ({ value }) => {
        const asked = Number(value)
        return Number.isInteger(asked) && asked > 0
          ? Effect.succeed({ count: Math.min(asked, MAX_COUNT), params: otherParams })
          : refuse('_count must be a whole number of at least 1.')
      },
    })
  )
}

/** `url` as a path under `fhirBaseUrl` (relative, no leading slash), if it is one. */
const pathUnderBaseOf = ({
  url,
  fhirBaseUrl,
}: {
  readonly url: string
  readonly fhirBaseUrl: string
}): Option.Option<string> => {
  const base = URL.parse(`${fhirBaseUrl}/`)
  const target = base === null ? null : URL.parse(url, base)
  if (base === null || target === null) return Option.none()
  return target.origin === base.origin && target.pathname.startsWith(base.pathname)
    ? Option.some(`${target.pathname.slice(base.pathname.length)}${target.search}`)
    : Option.none()
}

/** A search result page, as far as the tools read it. */
const SearchBundle = Schema.Struct({
  resourceType: Schema.Literal('Bundle'),
  total: Schema.optional(Schema.Number),
  entry: Schema.optional(
    Schema.Array(Schema.Struct({ resource: Schema.optional(Schema.Unknown) }))
  ),
  link: Schema.optional(
    Schema.Array(Schema.Struct({ relation: Schema.String, url: Schema.String }))
  ),
})

/** The patient a chat's reads are kept to, if it is about one. */
const pinnedPatientIdOf = (patient: ChatPatient.Type): Option.Option<string> =>
  patient.kind === 'patient' ? Option.some(patient.patientId) : Option.none()

/** Refuse `records` if any is about a patient other than the chat's. */
const refuseOtherPatientsRecords = (
  tools: Type,
  records: readonly unknown[]
): Effect.Effect<void, ToolCallRefused> =>
  Option.match(pinnedPatientIdOf(tools.patient), {
    onNone: () => Effect.void,
    onSome: (patientId) =>
      records.some((record) => PatientPin.isAboutAnotherPatient(record, patientId))
        ? refuse(
            "The server answered with records about another patient, so none are shown: this chat is about one patient. Search more narrowly, or don't include other records."
          )
        : Effect.void,
  })

/** The type a page path (`Observation?…`, or `?…` for a server's paging handle) searches, `''` for none. */
const searchedTypeOf = (path: string): string => path.split(/[?/]/u)[0] ?? ''

/** The opaque cursor for the page at `path`. */
const cursorOf = (path: string): string => Encoding.encodeBase64Url(path)

/** The page at `path` as the tool result's JSON. */
const readPage = (
  tools: Type,
  path: string
): Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> =>
  Effect.gen(function* () {
    const records = yield* FhirRecords
    const bundle = yield* records.read(path)
    const page = yield* Schema.decodeUnknown(SearchBundle)(bundle).pipe(
      Effect.mapError(
        () => new ToolCallRefused({ reason: "The server's answer wasn't a search result bundle." })
      )
    )
    const resources = Array.filterMap(page.entry ?? [], ({ resource }) =>
      Option.fromNullable(resource)
    )
    yield* refuseOtherPatientsRecords(tools, resources)
    const nextUrl = Array.findFirst(page.link ?? [], ({ relation }) => relation === 'next').pipe(
      Option.map(({ url }) => url)
    )
    const nextPath = Option.flatMap(nextUrl, (url) =>
      pathUnderBaseOf({ url, fhirBaseUrl: records.fhirBaseUrl })
    )
    return JSON.stringify({
      resources,
      ...(page.total === undefined ? {} : { total: page.total }),
      more: Option.isSome(nextUrl),
      ...Option.match(nextPath, {
        onNone: () => ({}),
        onSome: (next) => ({ next: cursorOf(next) }),
      }),
    })
  })

const searchRecords = (
  tools: Type,
  input: unknown
): Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> =>
  Effect.gen(function* () {
    const { resourceType, params } = yield* decodeInput(SearchRecordsInput, input)
    const searchedType = yield* offeredTypeOf(tools.searchableTypes, resourceType)
    yield* Array.findFirst(params, ({ name }) => !SEARCH_PARAM_NAME.test(name)).pipe(
      Option.match({
        onNone: () => Effect.void,
        onSome: ({ name }) => refuse(`"${name}" isn't a search parameter name.`),
      })
    )
    const page = yield* pageSizeOf(params)
    const pinnedParams = yield* Option.match(pinnedPatientIdOf(tools.patient), {
      onNone: () => Effect.succeed(page.params),
      onSome: (patientId) =>
        PatientPin.of(searchedType).pipe(
          Option.match({
            onNone: () => refuse(`${searchedType} can't be kept to one patient.`),
            onSome: (pin) =>
              Either.match(PatientPin.pinnedParamsOf(pin, patientId, page.params), {
                onLeft: (name) =>
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
      ['_count', String(page.count)],
    ])
    return yield* readPage(tools, `${searchedType}?${query.toString()}`)
  })

const nextPage = (
  tools: Type,
  input: unknown
): Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> =>
  Effect.gen(function* () {
    const { cursor } = yield* decodeInput(NextPageInput, input)
    const { fhirBaseUrl } = yield* FhirRecords
    const notACursor = new ToolCallRefused({
      reason: "That isn't a cursor a search gave. Search again with search_records.",
    })
    const path = yield* Encoding.decodeBase64UrlString(cursor).pipe(
      Either.flatMap((decoded) =>
        Either.fromOption(pathUnderBaseOf({ url: decoded, fhirBaseUrl }), () => notACursor)
      ),
      Either.mapLeft(() => notACursor)
    )
    const searchedType = searchedTypeOf(path)
    if (searchedType !== '') yield* offeredTypeOf(tools.searchableTypes, searchedType)
    return yield* readPage(tools, path)
  })

const readRecord = (
  tools: Type,
  input: unknown
): Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> =>
  Effect.gen(function* () {
    const { resourceType, id } = yield* decodeInput(ReadRecordInput, input)
    const readType = yield* offeredTypeOf(tools.readableTypes, resourceType)
    const recordId = yield* Schema.decodeUnknown(IdSchema)(id).pipe(
      Effect.mapError(() => new ToolCallRefused({ reason: `"${id}" isn't a FHIR id.` }))
    )
    const records = yield* FhirRecords
    const record = yield* records.read(`${readType}/${recordId}`)
    yield* Option.match(pinnedPatientIdOf(tools.patient), {
      onNone: () => Effect.void,
      onSome: (patientId) =>
        PatientPin.isAboutAnotherPatient(record, patientId)
          ? refuse(
              "This record is about another patient, so it isn't shown: this chat is about one patient."
            )
          : Effect.void,
    })
    return JSON.stringify(record)
  })

/** A `CapabilityStatement`, as far as `capabilities` reads it. */
const CapabilityStatementSearches = Schema.Struct({
  resourceType: Schema.Literal('CapabilityStatement'),
  rest: Schema.optional(
    Schema.Array(
      Schema.Struct({
        resource: Schema.optional(
          Schema.Array(
            Schema.Struct({
              type: Schema.String,
              searchParam: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
            })
          )
        ),
      })
    )
  ),
})

const capabilities = (
  tools: Type,
  input: unknown
): Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> =>
  Effect.gen(function* () {
    yield* decodeInput(CapabilitiesInput, input)
    const records = yield* FhirRecords
    const statement = yield* records.read('metadata').pipe(
      Effect.flatMap(Schema.decodeUnknown(CapabilityStatementSearches)),
      Effect.catchTag('ParseError', () =>
        refuse("The server's answer wasn't a CapabilityStatement.")
      )
    )
    const searchable: ReadonlySet<string> = new Set(tools.searchableTypes)
    const resourceTypes = (statement.rest ?? [])
      .flatMap(({ resource }) => resource ?? [])
      .filter(({ type }) => searchable.has(type))
      .map(({ type, searchParam }) => ({
        type,
        searchParams: (searchParam ?? []).map(({ name }) => name),
      }))
    return JSON.stringify({ resourceTypes })
  })

/** What the agent is told of a read the server failed. */
const fhirFailureTextOf = ({ failure }: FhirReadFailed): string =>
  Match.value(failure).pipe(
    Match.when({ kind: 'error-status' }, ({ status, outcomeText }) => {
      const answered = `The FHIR server answered ${String(status)}.`
      return Option.match(outcomeText, {
        onNone: () => answered,
        onSome: (text) => `${answered} It said: ${text}`,
      })
    }),
    Match.when({ kind: 'unreachable' }, () => "The FHIR server couldn't be reached."),
    Match.when({ kind: 'not-json' }, () => "The FHIR server's answer wasn't JSON."),
    Match.exhaustive
  )

/**
 * Run `call` with `tools`, against the FHIR server in the context, and
 * succeed with its tool result: the JSON the tool read, or `is_error: true`
 * and why it failed. A call to a tool the chat doesn't have is a failed
 * result too.
 */
const run = (
  tools: Type,
  call: Pick<BetaToolUseBlockParam, 'id' | 'name' | 'input'>
): Effect.Effect<BetaToolResultBlockParam, never, FhirRecords> => {
  const offered = tools.definitions.some(({ name }) => name === call.name)
  const result: Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> = offered
    ? Match.value(call.name).pipe(
        Match.when(SEARCH_RECORDS, () => searchRecords(tools, call.input)),
        Match.when(NEXT_PAGE, () => nextPage(tools, call.input)),
        Match.when(READ_RECORD, () => readRecord(tools, call.input)),
        Match.when(CAPABILITIES, () => capabilities(tools, call.input)),
        Match.orElse(() => refuse(`There is no tool called ${call.name}.`))
      )
    : refuse(`There is no tool called ${call.name}.`)
  return result.pipe(
    Effect.match({
      onSuccess: (content): BetaToolResultBlockParam => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content,
      }),
      onFailure: (failure): BetaToolResultBlockParam => ({
        type: 'tool_result',
        tool_use_id: call.id,
        is_error: true,
        content: Match.value(failure).pipe(
          Match.tag('ToolCallRefused', ({ reason }) => reason),
          Match.tag('FhirReadFailed', fhirFailureTextOf),
          Match.exhaustive
        ),
      }),
    })
  )
}

export {
  CAPABILITIES,
  CapabilitiesInput,
  DEFAULT_COUNT,
  make,
  MAX_COUNT,
  NEXT_PAGE,
  NextPageInput,
  READ_RECORD,
  ReadRecordInput,
  run,
  SEARCH_RECORDS,
  SearchRecordsInput,
}
export type { Type }
