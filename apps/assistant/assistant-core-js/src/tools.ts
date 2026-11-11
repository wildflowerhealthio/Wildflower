import type {
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import {
  diffJson,
  type ResourceWrite,
  withoutServerManagedMeta,
} from '@wildflowerhealthio/fhir-r4/clients'
import { IdSchema } from '@wildflowerhealthio/fhir-r4/data-types'
import { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import {
  Array,
  Data,
  Effect,
  Encoding,
  Either,
  Match,
  Option,
  Predicate,
  Record as EffectRecord,
  Schema,
  String as Str,
} from 'effect'

import * as ChatPatient from './chat-patient.ts'
import * as Chat from './chat.ts'
import { type FhirReadFailed, FhirRecords, type FhirWriteFailed } from './fhir-records.ts'
import * as PatientPin from './patient-pin.ts'
import * as RecordAccess from './record-access.ts'
import * as SearchParam from './search-param.ts'
import type * as WriteProposal from './write-proposal.ts'

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
 * - `create_record` — propose a new record, which the person approves or
 *   declines before it is created.
 * - `update_record` — propose a change to a record read in this chat, shown
 *   field by field, which the person approves or declines before it is
 *   saved against the version that was read.
 *
 * There is no delete tool under any grant: a record entered by mistake is
 * marked `entered-in-error` through an update. A read runs with {@link run};
 * a write is first a {@link WriteProposal} ({@link propose}), run once the
 * person decides ({@link carryOut}).
 *
 * In a chat about one patient, each search is pinned to them
 * ({@link PatientPin}), every record read back is checked to be theirs, and
 * every record written is about them or no one patient; a type nothing pins
 * is not offered. A failed call is a tool result with `is_error: true`
 * saying why, the server's `OperationOutcome` text included.
 *
 * @packageDocumentation
 */

const SEARCH_RECORDS = 'search_records'
const NEXT_PAGE = 'next_page'
const READ_RECORD = 'read_record'
const CAPABILITIES = 'capabilities'
const CREATE_RECORD = 'create_record'
const UPDATE_RECORD = 'update_record'

/** The page size a search asks for unless the agent sets `_count`. */
const DEFAULT_COUNT = 20

/** The most a search may ask for in one page. */
const MAX_COUNT = 50

/** `search_records`' input. */
const SearchRecordsInput = Schema.Struct({
  resourceType: Schema.String,
  params: Schema.Array(SearchParam.Schema),
})

/** `next_page`'s input. */
const NextPageInput = Schema.Struct({ cursor: Schema.String })

/** `read_record`'s input. */
const ReadRecordInput = Schema.Struct({ resourceType: Schema.String, id: Schema.String })

/** `capabilities`' input: nothing. */
const CapabilitiesInput = Schema.Struct({})

/** A resource as the agent writes it: FHIR JSON naming its `resourceType`. */
const ResourceInput = Schema.Struct(
  { resourceType: Schema.String },
  Schema.Record({ key: Schema.String, value: Schema.Unknown })
)

/** `create_record`'s and `update_record`'s input: the whole resource to write. */
const WriteRecordInput = Schema.Struct({ resource: ResourceInput })

/**
 * `search_records`' and `next_page`'s result, as the JSON the agent reads:
 * one page of `resources`; `total` when the server counted the matches;
 * `more` when the server has another page, and the `next` cursor to it when
 * that page is under the FHIR base.
 */
const PageResult = Schema.parseJson(
  Schema.Struct({
    resources: Schema.Array(Schema.Unknown),
    total: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
    more: Schema.Boolean,
    next: Schema.optionalWith(Schema.String, { exact: true }),
  })
)

/** `read_record`'s result, as the JSON the agent reads: the record as the server sent it. */
const ReadRecordResult = Schema.parseJson()

/**
 * `capabilities`' result, as the JSON the agent reads: for each type the
 * chat can search that the server's `CapabilityStatement` lists, the search
 * parameters it lists for it.
 */
const CapabilitiesResult = Schema.parseJson(
  Schema.Struct({
    resourceTypes: Schema.Array(
      Schema.Struct({ type: ResourceType.Schema, searchParams: Schema.Array(Schema.String) })
    ),
  })
)

/**
 * `create_record`'s and `update_record`'s result, as the JSON the agent
 * reads: the record as the server stored it, its type, the id it is stored
 * under, and its `versionId` when the server keeps versions.
 */
const WriteRecordResult = Schema.parseJson(
  Schema.Struct({
    resourceType: ResourceType.Schema,
    id: Schema.String,
    versionId: Schema.optionalWith(Schema.String, { exact: true }),
    record: Schema.Unknown,
  })
)

/** The tools of one chat, and what they were built from. */
interface Type {
  readonly patient: ChatPatient.Type
  /** The types `search_records` offers, in R4's order; empty when it is not offered. */
  readonly searchableTypes: readonly ResourceType.Type[]
  /** The types `read_record` offers, in R4's order; empty when it is not offered. */
  readonly readableTypes: readonly ResourceType.Type[]
  /** The types `create_record` offers, in R4's order; empty when it is not offered. */
  readonly creatableTypes: readonly ResourceType.Type[]
  /** The types `update_record` offers, in R4's order; empty when it is not offered. */
  readonly updatableTypes: readonly ResourceType.Type[]
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

/** The JSON Schema of a write tool's `resource`: an object whose `resourceType` is one of `types`. */
const resourceInputSchemaOf = (
  types: readonly ResourceType.Type[],
  description: string
): Record<string, unknown> => ({
  type: 'object',
  description,
  properties: { resourceType: enumOf(types, "The record's FHIR resource type.") },
  required: ['resourceType'],
})

/** What every write tool's description says of the person's decision. */
const WRITE_DECISION_NOTE =
  ' Nothing is saved until the person approves it: the result is the stored record, or why it was not saved. "The user declined this change." means they said no, followed by their reason when they gave one.'

/**
 * `create_record`'s definition. Not `strict`: a resource is an open object,
 * which strict tool schemas can't express (every object there must forbid
 * properties it doesn't list); the input is decoded before it runs.
 */
const createRecordDefinition = (
  patient: ChatPatient.Type,
  creatableTypes: readonly ResourceType.Type[]
): BetaTool => ({
  name: CREATE_RECORD,
  description:
    'Propose a new record for the FHIR server, as a whole FHIR R4 resource in JSON, without an id: the server assigns one.' +
    WRITE_DECISION_NOTE +
    (patient.kind === 'patient'
      ? " This chat is about one patient: the tool sets the record's subject or patient reference to them, so a record about a patient needs one of those elements, and a record about another patient is refused."
      : ''),
  input_schema: {
    type: 'object',
    properties: {
      resource: resourceInputSchemaOf(creatableTypes, 'The new record, as FHIR R4 JSON.'),
    },
    required: ['resource'],
    additionalProperties: false,
  },
})

/** `update_record`'s definition; not `strict`, as `create_record`'s isn't. */
const updateRecordDefinition = (
  patient: ChatPatient.Type,
  updatableTypes: readonly ResourceType.Type[]
): BetaTool => ({
  name: UPDATE_RECORD,
  description:
    'Propose a change to a record you have read in this chat (with read_record, search_records or next_page): give the whole record as it should be, as FHIR R4 JSON with its id, not only the fields that change. The person sees each field that changes.' +
    WRITE_DECISION_NOTE +
    " It is saved only if the record is still the version you read; if it changed, read it again and propose the change afresh. Records are never deleted: to retract one entered by mistake, set its status to entered-in-error (or the type's equivalent)." +
    (patient.kind === 'patient'
      ? ' This chat is about one patient: only their records can be changed.'
      : ''),
  input_schema: {
    type: 'object',
    properties: {
      resource: resourceInputSchemaOf(
        updatableTypes,
        'The whole record as it should be, with its id.'
      ),
    },
    required: ['resource'],
    additionalProperties: false,
  },
})

/** The types `resourceTypes` covers that a chat about `patient` can keep to them. */
const offeredTypesOf = (
  resourceTypes: RecordAccess.ResourceTypes,
  patient: ChatPatient.Type
): readonly ResourceType.Type[] =>
  RecordAccess.typesOf(resourceTypes).filter(
    (resourceType) => patient.kind === 'all-patients' || Option.isSome(PatientPin.of(resourceType))
  )

/**
 * The types `create_record` offers a chat about `patient`: those
 * `creatable` covers that the chat can keep to them, but in a chat about one
 * patient not `Patient`, since a new patient is not that patient, nor a type
 * the tool can't point at them ({@link PatientPin.canBePointedAtPatient}).
 */
const creatableTypesOf = (
  creatable: RecordAccess.ResourceTypes,
  patient: ChatPatient.Type
): readonly ResourceType.Type[] =>
  offeredTypesOf(creatable, patient).filter(
    (resourceType) =>
      patient.kind === 'all-patients' ||
      (resourceType !== 'Patient' && PatientPin.canBePointedAtPatient(resourceType))
  )

/**
 * The tools for a chat about `patient` under `access`: searching (with
 * `next_page` and `capabilities`) when some type can be searched, reading
 * by id when some type can be read, proposing new records and changes when
 * some type can be created or updated, each offering only those types.
 * Nothing deletes, whatever the grant.
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
  const creatableTypes = creatableTypesOf(access.creatable, patient)
  const updatableTypes = offeredTypesOf(access.updatable, patient)
  return {
    patient,
    searchableTypes,
    readableTypes,
    creatableTypes,
    updatableTypes,
    definitions: [
      ...(searchableTypes.length > 0
        ? [
            searchRecordsDefinition(patient, searchableTypes),
            NEXT_PAGE_DEFINITION,
            CAPABILITIES_DEFINITION,
          ]
        : []),
      ...(readableTypes.length > 0 ? [readRecordDefinition(patient, readableTypes)] : []),
      ...(creatableTypes.length > 0 ? [createRecordDefinition(patient, creatableTypes)] : []),
      ...(updatableTypes.length > 0 ? [updateRecordDefinition(patient, updatableTypes)] : []),
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
  if (base === null || target === null || target.origin !== base.origin) return Option.none()
  // The base itself (`<base>?_getpages=…`, a server's paging handle) is under it too.
  if (`${target.pathname}/` === base.pathname) return Option.some(target.search)
  return target.pathname.startsWith(base.pathname)
    ? Option.some(`${target.pathname.slice(base.pathname.length)}${target.search}`)
    : Option.none()
}

/** A search result page, as far as the tools read it. */
const SearchBundle = Schema.Struct({
  resourceType: Schema.Literal('Bundle'),
  total: Schema.optional(Schema.NonNegativeInt),
  entry: Schema.optional(
    Schema.Array(Schema.Struct({ resource: Schema.optional(Schema.Unknown) }))
  ),
  link: Schema.optional(
    Schema.Array(Schema.Struct({ relation: Schema.String, url: Schema.String }))
  ),
})

/** Refuse `records` if any is about a patient other than the chat's. */
const refuseOtherPatientsRecords = (
  tools: Type,
  records: readonly unknown[]
): Effect.Effect<void, ToolCallRefused> =>
  Option.match(ChatPatient.patientIdIfOne(tools.patient), {
    onNone: () => Effect.void,
    onSome: (patientId) =>
      records.some((record) => PatientPin.isAboutAnotherPatient(record, patientId))
        ? refuse(
            "The server answered with records about another patient, so none are shown: this chat is about one patient. Search more narrowly, or don't include other records."
          )
        : Effect.void,
  })

/**
 * The most characters of JSON a read's result may hold. A larger one (a
 * document with its file inline, say) would not fit a request, and a kept
 * round is sent again with every later question.
 */
const MAX_RESULT_CHARACTERS = 400_000

/** `json`, a read's result, or refused when it is over {@link MAX_RESULT_CHARACTERS}. */
const withinResultLimit = (json: string): Effect.Effect<string, ToolCallRefused> =>
  json.length > MAX_RESULT_CHARACTERS
    ? refuse(
        `The result is too large to show (${String(json.length)} characters; the most is ${String(MAX_RESULT_CHARACTERS)}). Search with a smaller _count, or with _elements naming the fields you need, leaving out large ones such as a document's content.`
      )
    : Effect.succeed(json)

/** The type a page path (`Observation?…`) searches; `None` for a server's paging handle (`?…`). */
const searchedTypeIfNamed = (path: string): Option.Option<string> =>
  Option.fromNullable(path.split(/[?/]/u)[0]).pipe(Option.filter(Str.isNonEmpty))

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
    return yield* withinResultLimit(
      Schema.encodeSync(PageResult)({
        resources,
        ...(page.total === undefined ? {} : { total: page.total }),
        more: Option.isSome(nextUrl),
        ...Option.match(nextPath, {
          onNone: () => ({}),
          onSome: (next) => ({ next: cursorOf(next) }),
        }),
      })
    )
  })

const searchRecords = (
  tools: Type,
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

const nextPage = (
  tools: Type,
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
    yield* Option.match(ChatPatient.patientIdIfOne(tools.patient), {
      onNone: () => Effect.void,
      onSome: (patientId) =>
        PatientPin.isAboutAnotherPatient(record, patientId)
          ? refuse(
              "This record is about another patient, so it isn't shown: this chat is about one patient."
            )
          : Effect.void,
    })
    return yield* withinResultLimit(Schema.encodeSync(ReadRecordResult)(record))
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
    const resourceTypes = (statement.rest ?? [])
      .flatMap(({ resource }) => resource ?? [])
      .flatMap(({ type, searchParam }) =>
        Array.findFirst(tools.searchableTypes, (searchableType) => searchableType === type).pipe(
          Option.map((searchableType) => ({
            type: searchableType,
            searchParams: (searchParam ?? []).map(({ name }) => name),
          })),
          Option.toArray
        )
      )
    return Schema.encodeSync(CapabilitiesResult)({ resourceTypes })
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

/** The tool result text for a change the person declined. */
const DECLINED_TEXT = 'The user declined this change.'

/** The tool result text for an update whose record changed since it was read. */
const STALE_RECORD_TEXT = 'The record changed since you read it; re-read it first.'

/** The opening of the tool result text for a write the server accepted but answered unreadably. */
const ACCEPTED_UNREADABLE_OPENING = 'The FHIR server accepted the change'

/** What the agent is told of a write the server failed. */
const writeFailureTextOf = ({ failure }: FhirWriteFailed): string =>
  Match.value(failure).pipe(
    Match.when({ kind: 'precondition-failed' }, () => STALE_RECORD_TEXT),
    Match.when({ kind: 'error-status' }, ({ status, outcomeText }) => {
      const answered = `The FHIR server answered ${String(status)}, so nothing was saved.`
      return Option.match(outcomeText, {
        onNone: () => answered,
        onSome: (text) => `${answered} It said: ${text}`,
      })
    }),
    Match.when(
      { kind: 'unreachable' },
      () => "The FHIR server couldn't be reached, so nothing was saved."
    ),
    Match.when(
      { kind: 'accepted-unreadable' },
      ({ status }) =>
        `${ACCEPTED_UNREADABLE_OPENING} (${String(status)}) but its answer couldn't be read, so it was probably saved. Search for the record before trying again.`
    ),
    Match.exhaustive
  )

/** A record as far as its version is read: its type, its id and its `meta.versionId`. */
const VersionedRecord = Schema.Struct({
  resourceType: Schema.String,
  id: Schema.String,
  meta: Schema.Struct({ versionId: Schema.String }),
})

const decodeVersionedRecord = Schema.decodeUnknownOption(VersionedRecord)
const decodeReadRecordResult = Schema.decodeUnknownOption(ReadRecordResult)
const decodePageResult = Schema.decodeUnknownOption(PageResult)
const decodeWriteRecordResult = Schema.decodeUnknownOption(WriteRecordResult)

/** The records the result `content` of a call to `toolName` holds; none for a tool that holds none. */
const recordsInResultOf = (toolName: string, content: unknown): readonly unknown[] =>
  Match.value(toolName).pipe(
    Match.when(READ_RECORD, () => Option.toArray(decodeReadRecordResult(content))),
    Match.whenOr(SEARCH_RECORDS, NEXT_PAGE, () =>
      decodePageResult(content).pipe(
        Option.map(({ resources }) => resources),
        Option.getOrElse((): readonly unknown[] => [])
      )
    ),
    Match.whenOr(CREATE_RECORD, UPDATE_RECORD, () =>
      decodeWriteRecordResult(content).pipe(
        Option.map(({ record }) => [record]),
        Option.getOrElse((): readonly unknown[] => [])
      )
    ),
    Match.orElse(() => [])
  )

/**
 * The version of each record the chat has read or written so far, by its
 * `Type/id`: every record a successful `read_record`, `search_records`,
 * `next_page`, `create_record` or `update_record` result in `chat` holds,
 * the latest seen of each. A record the server keeps no version of is not
 * in it, since it can't be updated against one.
 */
const versionsReadIn = (chat: Chat.Type): ReadonlyMap<string, string> =>
  new Map(
    chat.entries.flatMap((entry) => {
      if (entry._tag !== 'tool-round') return []
      const toolNameById = new Map(
        Chat.toolCallsOf(entry.message).map(({ id, name }) => [id, name] as const)
      )
      return entry.results.flatMap(({ tool_use_id, is_error, content }) =>
        is_error === true
          ? []
          : recordsInResultOf(toolNameById.get(tool_use_id) ?? '', content).flatMap((record) =>
              decodeVersionedRecord(record).pipe(
                Option.map(
                  ({ resourceType, id, meta }) => [`${resourceType}/${id}`, meta.versionId] as const
                ),
                Option.toArray
              )
            )
      )
    })
  )

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

/** A record as far as its contained resources are read. */
const RecordWithContained = Schema.Struct({ contained: Schema.Array(Schema.Unknown) })

const decodeRecordWithContained = Schema.decodeUnknownOption(RecordWithContained)

/** `record` and the resources it contains, each of which a write stores with it. */
const recordAndContainedOf = (record: unknown): readonly unknown[] => [
  record,
  ...decodeRecordWithContained(record).pipe(
    Option.map(({ contained }) => contained),
    Option.getOrElse((): readonly unknown[] => [])
  ),
]

/**
 * Refuse `record`, a record to write or the record a write changes, if the
 * chat is about one patient and it, or a resource it contains, is about
 * another.
 */
const refuseIfAboutAnotherPatient = (
  tools: Type,
  record: unknown,
  reason: string
): Effect.Effect<void, ToolCallRefused> =>
  Option.match(ChatPatient.patientIdIfOne(tools.patient), {
    onNone: () => Effect.void,
    onSome: (patientId) =>
      recordAndContainedOf(record).some((each) => PatientPin.isAboutAnotherPatient(each, patientId))
        ? refuse(reason)
        : Effect.void,
  })

/** The elements a record about a patient names them by. */
const PATIENT_REFERENCE_ELEMENTS = ['subject', 'patient'] as const

/**
 * The reference to `Patient/<patientId>` a pinned element is replaced with,
 * whatever the agent put there: an `identifier`, `display` or `type` beside
 * it could name someone else.
 */
const referenceToPatient = (patientId: string): { readonly reference: string } => ({
  reference: `Patient/${patientId}`,
})

/**
 * `resource`, of `resourceType`, as a chat about `patient` creates it: in a
 * chat about one patient, a record about a patient has its `subject` and
 * `patient` elements replaced with a reference to them, and is refused when
 * it has neither; any other record is created as given.
 */
const pinnedForCreate = (
  patient: ChatPatient.Type,
  resourceType: ResourceType.Type,
  resource: ResourceWrite.ResourceJson
): Effect.Effect<ResourceWrite.ResourceJson, ToolCallRefused> =>
  Option.match(ChatPatient.patientIdIfOne(patient), {
    onNone: () => Effect.succeed(resource),
    onSome: (patientId) =>
      PatientPin.of(resourceType).pipe(
        Option.filter((pin) => pin.kind === 'by-reference'),
        Option.match({
          onNone: () => Effect.succeed(resource),
          onSome: () => {
            const elements = PATIENT_REFERENCE_ELEMENTS.filter((name) =>
              Object.hasOwn(resource, name)
            )
            return Array.isNonEmptyReadonlyArray(elements)
              ? Effect.succeed({
                  ...resource,
                  ...Object.fromEntries(
                    elements.map((name) => [name, referenceToPatient(patientId)])
                  ),
                })
              : refuse(
                  `A ${resourceType} is about a patient: add its subject or patient reference (whichever the type has), and the tool points it at Patient/${patientId}, the patient this chat is about.`
                )
          },
        })
      ),
  })

/** The proposal for the `create_record` call `call`, or why it is refused. */
const proposeCreate = (
  tools: Type,
  call: Call
): Effect.Effect<WriteProposal.Type, ToolCallRefused> =>
  Effect.gen(function* () {
    const { resource } = yield* decodeInput(WriteRecordInput, call.input)
    if (tools.patient.kind === 'patient' && resource.resourceType === 'Patient') {
      return yield* refuse(
        "This chat is about one patient, so it can't create a Patient: a new patient isn't this one."
      )
    }
    const createdType = yield* offeredTypeOf(tools.creatableTypes, resource.resourceType)
    if (Object.hasOwn(resource, 'id')) {
      return yield* refuse('Leave out the id: the server assigns one to a new record.')
    }
    yield* refuseIfAboutAnotherPatient(
      tools,
      resource,
      "This record is about another patient, so it can't be created: this chat is about one patient."
    )
    const pinned = yield* pinnedForCreate(tools.patient, createdType, {
      ...resource,
      resourceType: createdType,
    })
    return { kind: 'create', callId: call.id, resource: pinned }
  })

/**
 * `record` as an update's diff reads it: its server-managed `meta` fields
 * dropped, and `meta` itself when nothing else is in it, so a change given
 * without `meta` doesn't read as removing one.
 */
const contentOf = (record: unknown): unknown => {
  const content = withoutServerManagedMeta(record)
  return Predicate.isRecord(content) &&
    Predicate.isRecord(content['meta']) &&
    EffectRecord.isEmptyRecord(content['meta'])
    ? EffectRecord.remove(content, 'meta')
    : content
}

/** The version `record` (a record read back) is at, if it says. */
const versionIdOf = (record: unknown): Option.Option<string> =>
  decodeVersionedRecord(record).pipe(Option.map(({ meta }) => meta.versionId))

/**
 * The proposal for the `update_record` call `call`, or why it is refused:
 * the record must have been read in this chat (`versionsRead`), and is read
 * again now, so the change is shown against the record as it is and
 * proposed only while that is still the version the agent read.
 */
const proposeUpdate = (
  tools: Type,
  call: Call,
  versionsRead: ReadonlyMap<string, string>
): Effect.Effect<WriteProposal.Type, ToolCallRefused | FhirReadFailed, FhirRecords> =>
  Effect.gen(function* () {
    const { resource } = yield* decodeInput(WriteRecordInput, call.input)
    const updatedType = yield* offeredTypeOf(tools.updatableTypes, resource.resourceType)
    const recordId = yield* Schema.decodeUnknown(IdSchema)(resource['id']).pipe(
      Effect.mapError(
        () => new ToolCallRefused({ reason: 'Give the id of the record to change, a FHIR id.' })
      )
    )
    const reference = `${updatedType}/${recordId}`
    const versionRead = yield* Option.fromNullable(versionsRead.get(reference)).pipe(
      Option.match({
        onNone: () =>
          refuse(
            `${reference} hasn't been read in this chat, so the version to change isn't known. Read it with read_record first.`
          ),
        onSome: Effect.succeed,
      })
    )
    const proposed = { ...resource, resourceType: updatedType, id: recordId }
    yield* refuseIfAboutAnotherPatient(
      tools,
      proposed,
      "This change would make the record about another patient, so it isn't proposed: this chat is about one patient."
    )
    const records = yield* FhirRecords
    const current = yield* records.read(reference)
    yield* refuseIfAboutAnotherPatient(
      tools,
      current,
      "This record is about another patient, so it can't be changed: this chat is about one patient."
    )
    if (!Option.contains(versionIdOf(current), versionRead)) {
      return yield* refuse(STALE_RECORD_TEXT)
    }
    const fields = diffJson(contentOf(current), contentOf(proposed))
    if (fields.length === 0) {
      return yield* refuse('The record already says this, so there is nothing to change.')
    }
    return { kind: 'update', callId: call.id, resource: proposed, versionId: versionRead, fields }
  })

/**
 * The write `call` asks for, as a proposal for the person to decide on
 * (`Right`); or, on the left, the tool result refusing it: a tool the chat
 * doesn't have, an input that doesn't decode, a type the tool doesn't
 * offer, a record about another patient in a chat about one, or an update
 * of a record not read in this chat or changed since. An update reads the
 * record again, so its proposal is against the record as it is now.
 */
const propose = (
  tools: Type,
  call: Call,
  versionsRead: ReadonlyMap<string, string>
): Effect.Effect<
  Either.Either<WriteProposal.Type, BetaToolResultBlockParam>,
  never,
  FhirRecords
> => {
  const offered = tools.definitions.some(({ name }) => name === call.name)
  const proposal: Effect.Effect<WriteProposal.Type, ToolCallRefused | FhirReadFailed, FhirRecords> =
    offered
      ? Match.value(call.name).pipe(
          Match.when(CREATE_RECORD, () => proposeCreate(tools, call)),
          Match.when(UPDATE_RECORD, () => proposeUpdate(tools, call, versionsRead)),
          Match.orElse(() => refuseUnknownTool(call))
        )
      : refuseUnknownTool(call)
  return Effect.either(proposal).pipe(
    Effect.map(Either.mapLeft((failure) => resultOf(call.id, Either.left(failure))))
  )
}

/** The result JSON for `written`, the record a write of `resourceType` stored. */
const writeRecordResultOf = (
  resourceType: ResourceType.Type,
  written: ResourceWrite.Written
): string =>
  Schema.encodeSync(WriteRecordResult)({
    resourceType,
    id: written.id,
    ...Option.match(written.versionId, {
      onNone: () => ({}),
      onSome: (versionId) => ({ versionId }),
    }),
    record: written.record,
  })

/** The tool result for a proposal the person declined, with their reason when they gave one. */
const declinedResultOf = (
  proposal: WriteProposal.Type,
  reason: Option.Option<string>
): BetaToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: proposal.callId,
  is_error: true,
  content: Option.match(reason, {
    onNone: () => DECLINED_TEXT,
    onSome: (given) => `${DECLINED_TEXT} Reason: ${given}`,
  }),
})

/**
 * The tool result for `proposal` once the person decided: approved, the
 * write is made (an update with `If-Match` naming the version it was
 * proposed against) and the result is the stored record, or why it wasn't
 * saved; declined, nothing is written and the result says so, with the
 * person's reason. Either way not saved is `is_error: true`.
 */
const carryOut = (
  proposal: WriteProposal.Type,
  decision: WriteProposal.Decision
): Effect.Effect<BetaToolResultBlockParam, never, FhirRecords> =>
  Match.value(decision).pipe(
    Match.when({ kind: 'declined' }, ({ reason }) =>
      Effect.succeed(declinedResultOf(proposal, reason))
    ),
    Match.when({ kind: 'approved' }, () =>
      Effect.flatMap(FhirRecords, (records) =>
        Match.value(proposal).pipe(
          Match.when({ kind: 'create' }, ({ resource }) => records.create({ resource })),
          Match.when({ kind: 'update' }, ({ resource, versionId }) =>
            records.update({ resource, versionId })
          ),
          Match.exhaustive
        )
      ).pipe(
        Effect.map((written) => writeRecordResultOf(proposal.resource.resourceType, written)),
        Effect.either,
        Effect.map((outcome) => resultOf(proposal.callId, outcome))
      )
    ),
    Match.exhaustive
  )

/** A tool call as a reply makes it. */
type Call = Pick<BetaToolUseBlockParam, 'id' | 'name' | 'input'>

/** The tool result for the call `callId` names: the tool's JSON, or `is_error: true` and why it failed. */
const resultOf = (
  callId: string,
  outcome: Either.Either<string, ToolCallRefused | FhirReadFailed | FhirWriteFailed>
): BetaToolResultBlockParam =>
  Either.match(outcome, {
    onRight: (content): BetaToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: callId,
      content,
    }),
    onLeft: (failure): BetaToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: callId,
      is_error: true,
      content: Match.value(failure).pipe(
        Match.tag('ToolCallRefused', ({ reason }) => reason),
        Match.tag('FhirReadFailed', fhirFailureTextOf),
        Match.tag('FhirWriteFailed', writeFailureTextOf),
        Match.exhaustive
      ),
    }),
  })

/** Whether `call` is to one of the tools that write: it is proposed, not run. */
const isWriteCall = (call: Pick<Call, 'name'>): boolean =>
  call.name === CREATE_RECORD || call.name === UPDATE_RECORD

/** Refuse `call` as naming no tool the chat has. */
const refuseUnknownTool = (call: Call): Effect.Effect<never, ToolCallRefused> =>
  refuse(`There is no tool called ${call.name}.`)

/**
 * Run the read `call` with `tools`, against the FHIR server in the context,
 * and succeed with its tool result: the JSON the tool read, or `is_error:
 * true` and why it failed. A call to a tool the chat doesn't have, or to a
 * write tool (which {@link propose} takes), is a failed result too.
 * `next_page` reads only a cursor in `cursorsIssued` ({@link cursorsIssuedIn}).
 */
const run = (
  tools: Type,
  call: Call,
  cursorsIssued: ReadonlySet<string>
): Effect.Effect<BetaToolResultBlockParam, never, FhirRecords> => {
  const offered = tools.definitions.some(({ name }) => name === call.name)
  const result: Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> = offered
    ? Match.value(call.name).pipe(
        Match.when(SEARCH_RECORDS, () => searchRecords(tools, call.input)),
        Match.when(NEXT_PAGE, () => nextPage(tools, call.input, cursorsIssued)),
        Match.when(READ_RECORD, () => readRecord(tools, call.input)),
        Match.when(CAPABILITIES, () => capabilities(tools, call.input)),
        Match.orElse(() => refuseUnknownTool(call))
      )
    : refuseUnknownTool(call)
  return Effect.map(Effect.either(result), (outcome) => resultOf(call.id, outcome))
}

export {
  ACCEPTED_UNREADABLE_OPENING,
  CAPABILITIES,
  CapabilitiesInput,
  CapabilitiesResult,
  carryOut,
  CREATE_RECORD,
  cursorsIssuedIn,
  DECLINED_TEXT,
  DEFAULT_COUNT,
  isWriteCall,
  make,
  MAX_COUNT,
  NEXT_PAGE,
  NextPageInput,
  PageResult,
  propose,
  READ_RECORD,
  ReadRecordInput,
  ReadRecordResult,
  run,
  SEARCH_RECORDS,
  SearchRecordsInput,
  STALE_RECORD_TEXT,
  UPDATE_RECORD,
  versionsReadIn,
  WriteRecordInput,
  WriteRecordResult,
}
export type { Call, Type }
