import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { Array as Arr, Effect, Layer, Option, Order, Schema } from 'effect'

import type { SmartClient } from './smart-client.ts'

/**
 * An in-memory FHIR server for driving the app end to end: searches answered
 * from its store through a stub fhirclient client, and batch `Bundle`s applied
 * to the same store through a stub transport the real
 * `buildSmartRouterContext` writes over.
 */

const SERVER_URL = 'http://127.0.0.1:8080/fhir-r4'
const ACCESS_TOKEN = 'tok-lift'

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

/** A search issued (`start`) or answered (`end`). */
interface SearchEvent {
  readonly kind: 'start' | 'end'
  readonly query: string
}

interface FakeFhirServer {
  /** Every search query the readers issued, in order. */
  readonly searches: string[]
  /** Every search's start and end, in order: a search is answered a macrotask after it is issued. */
  readonly searchEvents: SearchEvent[]
  /** The most searches in flight at once so far. */
  readonly mostSearchesInFlight: () => number
  /** Every request that reached the transport (the batch writes), in order. */
  readonly requests: RecordedRequest[]
  /** Every batch `Bundle`'s resources, one array per batch, in order. */
  readonly writes: (readonly unknown[])[]
  readonly transport: Layer.Layer<HttpClient.HttpClient>
  readonly clientFor: (patientId: string | null) => SmartClient
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

/**
 * An in-memory FHIR server: searches answered from its store, paged at
 * {@link PAGE_SIZE} with a `next` link; batch `Bundle`s applied to it entry by
 * entry.
 */
const fakeFhirServer = (): FakeFhirServer => {
  const store = new Map<string, unknown>()
  const searches: string[] = []
  const searchEvents: SearchEvent[] = []
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

  const clientFor = (patientId: string | null): SmartClient => {
    const stub = {
      request: (query: string): Promise<unknown> => {
        searches.push(query)
        if (searchesFail) return Promise.reject(new Error('search refused by test server'))
        searchEvents.push({ kind: 'start', query })
        return new Promise((resolve) => {
          setTimeout(() => {
            searchEvents.push({ kind: 'end', query })
            resolve(searchset(query))
          }, 0)
        })
      },
      patient: { id: patientId },
      state: { serverUrl: SERVER_URL, tokenResponse: { access_token: ACCESS_TOKEN } },
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only stub: the app reads `request`, `patient.id` and `state`
    return stub as unknown as SmartClient
  }

  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
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
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({ resourceType: 'Bundle', type: 'batch-response', entry: responses }),
              { status: 200, headers: { 'content-type': 'application/fhir+json' } }
            )
          )
        )
      )
    })
  )

  return {
    searches,
    searchEvents,
    mostSearchesInFlight: () =>
      Arr.reduce(searchEvents, { inFlight: 0, most: 0 }, ({ inFlight, most }, { kind }) => {
        const next = kind === 'start' ? inFlight + 1 : inFlight - 1
        return { inFlight: next, most: Math.max(most, next) }
      }).most,
    requests,
    writes,
    transport,
    clientFor,
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
  type SearchEvent,
  idsOf,
  resourceTypeOfQuery,
  resourceTypeOfWire,
  searchParamsOf,
  SERVER_URL,
}
