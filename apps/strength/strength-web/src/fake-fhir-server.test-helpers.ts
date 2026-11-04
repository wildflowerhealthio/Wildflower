import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { Array as Arr, Effect, Layer, Option, Order, Schema } from 'effect'

import {
  decodeFhirBaseUrl,
  SmartConnection,
  SmartRuntimeContext,
  smartRuntimeFor,
  type SmartRuntime,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { createElement, type ReactElement } from 'react'

/**
 * An in-memory FHIR server for driving the app end to end: one stub transport
 * that answers searches and reads from its store and applies batch `Bundle`s
 * to it, which the real `smartRuntimeFor` reads and writes over.
 */

const SERVER_URL = 'http://127.0.0.1:8080'
const ACCESS_TOKEN = 'tok-lift'

/** The connection a launch naming `patientId` (`null` for none) makes to the fake server. */
const connectionFor = (patientId: string | null): SmartConnection =>
  new SmartConnection({
    fhirBaseUrl: decodeFhirBaseUrl(SERVER_URL),
    accessToken: Option.some(ACCESS_TOKEN),
    launchPatientId: Option.fromNullable(patientId),
  })

/** The codings of a concept the fake server searches on. */
const CodeableConceptFields = Schema.Struct({
  coding: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          system: Schema.optional(Schema.NullOr(Schema.String)),
          code: Schema.optional(Schema.NullOr(Schema.String)),
        })
      )
    )
  ),
})

/** The literal reference of a reference the fake server searches on. */
const ReferenceFields = Schema.Struct({ reference: Schema.optional(Schema.NullOr(Schema.String)) })

/** The fields of a stored resource the fake server searches on. */
const StoredResourceFields = Schema.Struct({
  resourceType: Schema.String,
  id: Schema.String,
  status: Schema.optional(Schema.NullOr(Schema.String)),
  subject: Schema.optional(
    Schema.NullOr(Schema.Struct({ reference: Schema.optional(Schema.NullOr(Schema.String)) }))
  ),
  // An array on most resources; one concept on a `Procedure`.
  category: Schema.optional(
    Schema.NullOr(Schema.Union(Schema.Array(CodeableConceptFields), CodeableConceptFields))
  ),
  topic: Schema.optional(Schema.NullOr(Schema.Array(CodeableConceptFields))),
  instantiatesCanonical: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  basedOn: Schema.optional(Schema.NullOr(Schema.Array(ReferenceFields))),
  partOf: Schema.optional(Schema.NullOr(Schema.Array(ReferenceFields))),
})
type StoredResourceFields = typeof StoredResourceFields.Type

const fieldsOf = (wire: unknown): StoredResourceFields =>
  Schema.decodeUnknownSync(StoredResourceFields)(wire)

const resourceTypeOfWire = (wire: unknown): string => fieldsOf(wire).resourceType

const idsOf = (batch: readonly unknown[] | undefined): readonly string[] =>
  (batch ?? []).map((wire) => fieldsOf(wire).id)

/** The resource type a search query names, relative or absolute. */
const resourceTypeOfQuery = (query: string): string => {
  const relative = query.startsWith(`${SERVER_URL}/`) ? query.slice(SERVER_URL.length + 1) : query
  return relative.split('?')[0] ?? ''
}

const searchParamsOf = (query: string): URLSearchParams =>
  new URLSearchParams(query.slice(query.indexOf('?') + 1))

/** The request entries of a batch `Bundle` the transport receives. */
const BatchBundle = Schema.parseJson(
  Schema.Struct({
    entry: Schema.Array(
      Schema.Struct({
        request: Schema.Struct({ method: Schema.String, url: Schema.String }),
        resource: Schema.Unknown,
      })
    ),
  })
)

/** One write request the transport saw. */
interface RecordedRequest {
  readonly url: string
  readonly authorization: string | undefined
}

interface FakeFhirServer {
  /** Every search the readers issued, its URL under the server's base, in order. */
  readonly searches: string[]
  /** Every read (`Type/id`) the readers issued, in order. */
  readonly reads: string[]
  /** Every batch write that reached the transport, in order. */
  readonly requests: RecordedRequest[]
  /** Every batch `Bundle`'s resources, one array per batch, in order. */
  readonly writes: (readonly unknown[])[]
  readonly transport: Layer.Layer<HttpClient.HttpClient>
  /** The connection a launch naming `patientId` (`null` for none) makes to this server. */
  readonly connectionFor: (patientId: string | null) => SmartConnection
  /** The runtime over {@link FakeFhirServer.connectionFor}'s connection and this transport. */
  readonly runtimeFor: (patientId: string | null) => SmartRuntime
  /**
   * What `render` makes of {@link FakeFhirServer.runtimeFor}'s runtime, with
   * the runtime provided to it, as `SmartHandshakeGate` provides it.
   */
  readonly underRuntime: (
    patientId: string | null,
    render: (runtime: SmartRuntime) => ReactElement
  ) => ReactElement
  readonly seedWire: (wire: unknown) => void
  /** Store a decoded resource as the app writes one: its JSON. */
  readonly seedResource: (resource: unknown) => void
  /** Every stored resource of `resourceType`, decoded through `schema`. */
  readonly stored: <A, I>(resourceType: string, schema: Schema.Schema<A, I>) => readonly A[]
  /** Refuse the first entry of `resourceType` the next batch carries, once. */
  readonly rejectOnce: (resourceType: string) => void
  /** Hold every batch's response until the returned function is called. */
  readonly holdWrites: () => () => void
  /** Fail every search from now on. */
  readonly failSearches: () => void
  /** The ids of the stored resources of `resourceType`, sorted. */
  readonly storedIds: (resourceType: string) => readonly string[]
}

/** How many entries the fake server puts on one search page — small, so paging is exercised. */
const PAGE_SIZE = 2

/** The `system|code` tokens a concept list carries. */
const tokensOf = (concepts: StoredResourceFields['category']): readonly string[] =>
  (concepts === undefined || concepts === null ? [] : Arr.ensure(concepts)).flatMap((concept) =>
    (concept.coding ?? []).map((coding) => `${coding.system ?? ''}|${coding.code ?? ''}`)
  )

/** The literal references a reference list carries. */
const referencesOf = (references: StoredResourceFields['basedOn']): readonly string[] =>
  (references ?? []).flatMap(({ reference }) =>
    reference === undefined || reference === null ? [] : [reference]
  )

/**
 * Whether a stored resource matches a search: `patient`, `status`,
 * `category`, `topic`, `instantiates-canonical`, `based-on` and `part-of`
 * honoured.
 */
const matches = (fields: StoredResourceFields, params: URLSearchParams): boolean => {
  const matchesParam = (name: string, values: readonly string[]): boolean => {
    const wanted = params.get(name)
    return wanted === null || values.includes(wanted)
  }
  return (
    matchesParam('patient', [fields.subject?.reference?.replace(/^Patient\//, '') ?? '']) &&
    matchesParam('status', [fields.status ?? '']) &&
    matchesParam('category', tokensOf(fields.category)) &&
    matchesParam('topic', tokensOf(fields.topic)) &&
    matchesParam('instantiates-canonical', fields.instantiatesCanonical ?? []) &&
    matchesParam('based-on', referencesOf(fields.basedOn)) &&
    matchesParam('part-of', referencesOf(fields.partOf))
  )
}

/** The JSON answer `status` the server gives `request`. */
const answer = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  status = 200
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/fhir+json' },
    })
  )

/**
 * An in-memory FHIR server: searches answered from its store, paged at
 * {@link PAGE_SIZE} with a `next` link; batch `Bundle`s applied to it entry by
 * entry.
 */
const fakeFhirServer = (): FakeFhirServer => {
  const store = new Map<string, unknown>()
  const searches: string[] = []
  const reads: string[] = []
  const requests: RecordedRequest[] = []
  const writes: (readonly unknown[])[] = []
  let rejectOnceType: string | null = null
  let held: Promise<void> = Promise.resolve()
  let searchesFail = false

  const seedWire = (wire: unknown): void => {
    const fields = fieldsOf(wire)
    store.set(`${fields.resourceType}/${fields.id}`, wire)
  }

  const searchset = (query: string): unknown => {
    searches.push(query)
    const resourceType = resourceTypeOfQuery(query)
    const params = searchParamsOf(query)
    const offset = Number(params.get('_offset') ?? '0')
    const found = [...store.values()].filter((wire) => {
      const fields = fieldsOf(wire)
      return fields.resourceType === resourceType && matches(fields, params)
    })
    params.set('_offset', String(offset + PAGE_SIZE))
    return {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: found.slice(offset, offset + PAGE_SIZE).map((resource) => ({ resource })),
      link:
        offset + PAGE_SIZE < found.length
          ? [{ relation: 'next', url: `${SERVER_URL}/${resourceType}?${params.toString()}` }]
          : [],
    }
  }

  /** A search (`Type?…`) or a read (`Type/id`) of the store. */
  const get = (
    request: HttpClientRequest.HttpClientRequest
  ): HttpClientResponse.HttpClientResponse => {
    const path = request.url.slice(SERVER_URL.length + 1)
    if (path.includes('?')) {
      return searchesFail ? answer(request, null, 403) : answer(request, searchset(path))
    }
    reads.push(path)
    return Option.match(Option.fromNullable(store.get(path)), {
      onNone: () => answer(request, null, 404),
      onSome: (wire) => answer(request, wire),
    })
  }

  /** A batch `Bundle` applied entry by entry, answered once any held writes are released. */
  const batch = (
    request: HttpClientRequest.HttpClientRequest
  ): Effect.Effect<HttpClientResponse.HttpClientResponse> => {
    requests.push({ url: request.url, authorization: request.headers['authorization'] })
    const bundle = Schema.decodeUnknownSync(BatchBundle)(decodeBody(request.body))
    writes.push(bundle.entry.map((entry) => entry.resource))
    const responses = bundle.entry.map((entry) => {
      const entryType = entry.request.url.split('/')[0] ?? ''
      if (rejectOnceType === entryType) {
        rejectOnceType = null
        return { response: { status: '422 Unprocessable Entity' } }
      }
      seedWire(entry.resource)
      return { response: { status: '201 Created' } }
    })
    const gate = held
    return Effect.promise(() => gate).pipe(
      Effect.as(
        answer(request, { resourceType: 'Bundle', type: 'batch-response', entry: responses })
      )
    )
  }

  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      request.method === 'GET' ? Effect.sync(() => get(request)) : batch(request)
    )
  )

  const runtimeFor = (patientId: string | null): SmartRuntime =>
    smartRuntimeFor(connectionFor(patientId), transport)

  return {
    searches,
    reads,
    requests,
    writes,
    transport,
    connectionFor,
    runtimeFor,
    underRuntime: (patientId, render) => {
      const runtime = runtimeFor(patientId)
      return createElement(SmartRuntimeContext, { value: runtime }, render(runtime))
    },
    seedWire,
    seedResource: (resource) => {
      seedWire(JSON.parse(JSON.stringify(resource)))
    },
    stored: (resourceType, schema) =>
      Arr.filterMap([...store.values()], (wire) =>
        resourceTypeOfWire(wire) === resourceType
          ? Option.some(Schema.decodeUnknownSync(schema)(wire))
          : Option.none()
      ),
    rejectOnce: (resourceType) => {
      rejectOnceType = resourceType
    },
    holdWrites: () => {
      let release: (() => void) | undefined
      held = new Promise((resolve) => {
        release = resolve
      })
      return () => {
        release?.()
        held = Promise.resolve()
      }
    },
    failSearches: () => {
      searchesFail = true
    },
    storedIds: (resourceType) =>
      [...store.values()]
        .map(fieldsOf)
        .filter((fields) => fields.resourceType === resourceType)
        .map(({ id }) => id)
        .toSorted(Order.string),
  }
}

const decodeBody = (body: HttpClientRequest.HttpClientRequest['body']): string =>
  body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : ''

export {
  ACCESS_TOKEN,
  type FakeFhirServer,
  fakeFhirServer,
  idsOf,
  resourceTypeOfQuery,
  resourceTypeOfWire,
  searchParamsOf,
  SERVER_URL,
}
