/**
 * The stub FHIR server the screen tests drive the importer over: it records
 * every request in one ordered log and holds what it is seeded with and what
 * is written to it.
 *
 * @remarks
 * The log is this module's, cleared by {@link clearRecorded} before each
 * test; each test file loads its own copy of the module.
 *
 * @packageDocumentation
 */
import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import {
  decodeFhirBaseUrl,
  type RunSmart,
  SmartConnection,
  smartRuntimeFor,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { Effect, Layer, Option, Schema } from 'effect'

import type { StoredSourceFile } from './screen-fixtures.ts'

/** Every request the stub server has seen since {@link clearRecorded}, in order. */
const recorded: RecordedRequest[] = []

/** The `type` of every Bundle `POST`ed to the base since {@link clearRecorded}, in order. */
const submittedBundles: string[] = []

/** Empty the request log and the submitted bundles. */
const clearRecorded = (): void => {
  recorded.length = 0
  submittedBundles.length = 0
}

/** The `type` of every Bundle submitted so far, in order: `batch` for a read, `transaction` for a write. */
const bundleTypes = (): readonly string[] => [...submittedBundles]

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const decodeBody = (body: HttpClientRequest.HttpClientRequest['body']): string =>
  body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : ''

/** One request the stub server saw: method, url, and decoded body. */
interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: string
}

/** The write requests recorded so far, in order. */
const writes = (): readonly RecordedRequest[] =>
  recorded.filter((request) => request.method === 'PUT' || request.method === 'POST')

/** Whether a write is a FHIR resource write (a Patient or Observation), not the source file. */
const isResourceWrite = (write: RecordedRequest): boolean =>
  write.url.includes('/Patient/') || write.url.includes('/Observation/')

/**
 * The read requests recorded so far, each as `read <Type>` or
 * `search <Type>?<sorted parameter names>`.
 */
const reads = (): readonly string[] =>
  recorded
    .filter((request) => request.method === 'GET' || request.method === 'SEARCH')
    .map((request) => {
      const [path = '', query] = request.url.split('?')
      const segments = path.split('/').filter((segment) => segment !== '' && segment !== '_search')
      if (query === undefined) return `read ${segments.at(-2) ?? ''}`
      const names = [...new URLSearchParams(query).keys()].toSorted().join('&')
      return `search ${segments.at(-1) ?? ''}?${names}`
    })

/** The `meta.source` a written resource carries, decoded rather than read off `any`. */
const MetaSourceWire = Schema.Struct({ meta: Schema.Struct({ source: Schema.String }) })
const metaSourceOf = (body: string): string =>
  Schema.decodeUnknownSync(MetaSourceWire)(JSON.parse(body)).meta.source

/** The last path segment of a request URL — a resource's logical id on a PUT/GetById. */
const idFromUrl = (url: string): string => {
  const path = url.split('?')[0] ?? url
  const segments = path.split('/')
  return segments[segments.length - 1] ?? ''
}

/** Just enough of a held resource to key it and search it by identifier, birth date and name. */
const HeldWire = Schema.Struct({
  resourceType: Schema.String,
  id: Schema.String,
  identifier: Schema.optionalWith(
    Schema.Array(Schema.Struct({ system: Schema.String, value: Schema.String })),
    { default: () => [] }
  ),
  birthDate: Schema.optional(Schema.String),
  name: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        family: Schema.optional(Schema.String),
        given: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
        text: Schema.optional(Schema.String),
      })
    ),
    { default: () => [] }
  ),
})
const heldWireOf = Schema.decodeUnknownSync(HeldWire)

/** `text` as HFS indexes a name part: lower-cased, without diacritics. */
const folded = (text: string): string =>
  text.normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase()

/**
 * Whether `wire` passes a typed search's `form` as HFS answers it: carrying
 * any of its `identifier` tokens, born on any of its `birthdate` dates, and
 * with a name part (family, a given name or text) starting with any of its
 * `name` values, case and accents folded; a parameter the form leaves out
 * filters nothing.
 */
const passesSearch = (wire: unknown, form: URLSearchParams): boolean => {
  const { identifier, birthDate, name } = heldWireOf(wire)
  const tokens = form.get('identifier')?.split(',')
  const birthDates = form.get('birthdate')?.split(',')
  const names = form.get('name')?.split(',')
  return (
    (tokens === undefined ||
      identifier.some(({ system, value }) => tokens.includes(`${system}|${value}`))) &&
    (birthDates === undefined || (birthDate !== undefined && birthDates.includes(birthDate))) &&
    (names === undefined ||
      name
        .flatMap(({ family, given, text }) => [family, ...given, text])
        .filter((part) => part !== undefined)
        .some((part) => names.some((value) => folded(part).startsWith(folded(value)))))
  )
}

/** A request URL with its search parameters, as the log records it. */
const urlWithParams = (request: HttpClientRequest.HttpClientRequest): string => {
  const params = new URLSearchParams(
    request.urlParams.map(([key, value]) => [key, value])
  ).toString()
  if (params === '') return request.url
  return `${request.url}${request.url.includes('?') ? '&' : '?'}${params}`
}

/** Whether `request` submits a `transaction` Bundle. */
const isTransaction = (request: HttpClientRequest.HttpClientRequest): boolean =>
  request.method === 'POST' && safeParseBundle(decodeBody(request.body))?.type === 'transaction'

/**
 * A stub server that records every request and holds what it is given and
 * what is written to it: a `category` search answers with the configured
 * source files, a typed `POST <Type>/_search` with the held resources of its
 * type it finds as HFS would (`passesSearch`: by `identifier`, `birthdate` or
 * `name`; one with none of them, every held resource of its type), a `GET`
 * `identifier` search with the held resources of its type carrying any of
 * its `system|value` tokens, a `GET` `_count`-only search with every held
 * resource of its type, a read with the held resource, and a PUT
 * stores and echoes its body (or a 503 when `failWrite` says so). A
 * `transaction` bundle one of whose entries `failWrite` rejects is refused
 * as a whole, as HFS refuses one: a 400 with an OperationOutcome, nothing
 * stored and no entry recorded as written. With `failSearches`, every typed
 * search answers 500; with `transactionsHeldUntil`, a transaction is answered
 * once that promise settles. Enough to drive the whole flow twice over and read the
 * log back.
 */
const routingServer = (config: {
  readonly sourceFiles?: readonly StoredSourceFile[]
  readonly stored?: readonly unknown[]
  readonly failWrite?: (request: { readonly method: string; readonly url: string }) => boolean
  readonly failSearches?: boolean
  readonly transactionsHeldUntil?: Promise<void>
}): RunSmart => {
  const sourceFiles = config.sourceFiles ?? []
  const held = new Map<string, unknown>([
    ...sourceFiles.map((one): [string, unknown] => [`DocumentReference/${one.id}`, one.wire]),
    ...(config.stored ?? []).map((wire): [string, unknown] => {
      const { resourceType, id } = heldWireOf(wire)
      return [`${resourceType}/${id}`, wire]
    }),
  ])
  const heldOfType = (resourceType: string): readonly unknown[] =>
    [...held.values()].filter((wire) => heldWireOf(wire).resourceType === resourceType)
  const respond = (
    request: HttpClientRequest.HttpClientRequest
  ): Effect.Effect<HttpClientResponse.HttpClientResponse> => {
    const body = decodeBody(request.body)
    // The SMART reader's source list carries its search in the URL; the
    // typed client's requests carry theirs as `urlParams`.
    const [path = '', query = ''] = request.url.split('?')
    const params = {
      ...Object.fromEntries(new URLSearchParams(query)),
      ...Object.fromEntries(request.urlParams),
    }

    // A `POST /` at the FHIR base with a Bundle body is `fhir-r4`'s
    // bundle-submit — a batch of PUT entries (persistBatchBundle) or GET
    // entries (classifyAgainstServer). Unwrap it: record each entry as its
    // own request (method + url from `entry.request`), and mirror the
    // batch-response bundle. That keeps `writes()` / `isResourceWrite`
    // seeing one recorded request per resource operation.
    if (request.method === 'POST' && (request.url === '/' || request.url.endsWith('/'))) {
      const parsed = safeParseBundle(body)
      if (parsed !== undefined) {
        submittedBundles.push(parsed.type ?? '')
        const entries = parsed.entry ?? []
        const refusedEntry = entries.find(
          (entry) =>
            entry.request?.method === 'PUT' &&
            config.failWrite?.({ method: 'PUT', url: `/${entry.request.url}` }) === true
        )
        if (parsed.type === 'transaction' && refusedEntry !== undefined) {
          recorded.push({ method: request.method, url: request.url, body })
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              jsonResponse(
                {
                  resourceType: 'OperationOutcome',
                  issue: [
                    {
                      severity: 'error',
                      code: 'processing',
                      diagnostics: `Transaction failed at entry ${entries.indexOf(refusedEntry)}`,
                    },
                  ],
                },
                400
              )
            )
          )
        }
        const responseEntries: unknown[] = []
        for (const entry of entries) {
          const entryReq = entry.request
          if (entryReq === undefined) {
            responseEntries.push({ response: { status: '400 Bad Request' } })
            continue
          }
          const entryUrl = `/${entryReq.url}`
          const entryBody = entry.resource === undefined ? '' : JSON.stringify(entry.resource)
          recorded.push({ method: entryReq.method, url: entryUrl, body: entryBody })
          if (
            entryReq.method === 'PUT' &&
            config.failWrite?.({ method: entryReq.method, url: entryUrl }) === true
          ) {
            responseEntries.push({ response: { status: '503 Service Unavailable' } })
            continue
          }
          if (entryReq.method === 'GET') {
            const stored = held.get(entryReq.url)
            responseEntries.push(
              stored === undefined
                ? { response: { status: '404 Not Found' } }
                : { response: { status: '200 OK' }, resource: stored }
            )
            continue
          }
          if (entry.resource !== undefined) held.set(entryReq.url, entry.resource)
          responseEntries.push({
            response: { status: '200 OK' },
            ...(entry.resource !== undefined ? { resource: entry.resource } : {}),
          })
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            jsonResponse({
              resourceType: 'Bundle',
              type: 'batch-response',
              entry: responseEntries,
            })
          )
        )
      }
    }

    const segments = path.split('/').filter((segment) => segment !== '')
    // A `POST <Type>/_search` is the typed client's search, its parameters
    // a form body: the matcher's identifier and name-stage searches, and
    // the referent rows' stored lists. Recorded as a read, its parameters
    // in its URL.
    if (request.method === 'POST' && segments.at(-1) === '_search') {
      const form = new URLSearchParams(body)
      recorded.push({ method: 'SEARCH', url: `${path}?${form.toString()}`, body: '' })
      if (config.failSearches === true) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(null, 500)))
      }
      const hits = heldOfType(segments.at(-2) ?? '').filter((wire) => passesSearch(wire, form))
      return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(searchset(hits))))
    }
    recorded.push({ method: request.method, url: urlWithParams(request), body })
    if (request.method === 'GET' && params['category'] !== undefined) {
      const wires = sourceFiles.map((one) => one.wire)
      return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(searchset(wires))))
    }
    if (request.method === 'GET' && params['_count'] !== undefined) {
      const tokens = params['identifier']?.split(',')
      const hits = heldOfType(segments.at(-1) ?? '').filter(
        (wire) =>
          tokens === undefined ||
          heldWireOf(wire).identifier.some(({ system, value }) =>
            tokens.includes(`${system}|${value}`)
          )
      )
      return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(searchset(hits))))
    }
    if (request.method === 'GET') {
      const stored = held.get(segments.slice(-2).join('/'))
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, jsonResponse(stored ?? null, stored ? 200 : 404))
      )
    }
    if (config.failWrite?.({ method: request.method, url: request.url }) === true) {
      return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(null, 503)))
    }
    // Echo the written wire back as a 200 so the client decodes it and succeeds.
    const written: unknown = body === '' ? {} : JSON.parse(body)
    return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(written)))
  }
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.zipRight(
        isTransaction(request) && config.transactionsHeldUntil !== undefined
          ? Effect.promise(() => config.transactionsHeldUntil ?? Promise.resolve())
          : Effect.void,
        Effect.suspend(() => respond(request))
      )
    )
  )
  // An empty FHIR base leaves every request the path it was made with, as the
  // log records it.
  return smartRuntimeFor(
    new SmartConnection({
      fhirBaseUrl: decodeFhirBaseUrl(''),
      accessToken: Option.none(),
      launchPatientId: Option.none(),
      grantedScopes: [],
    }),
    httpLayer
  ).runSmart
}

const searchset = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [],
})

/** Minimal shape read from the request body of a `POST /` bundle. */
interface RecordedBundleShape {
  readonly type?: string
  readonly entry?: readonly {
    readonly request?: { readonly method: string; readonly url: string }
    readonly resource?: unknown
  }[]
}

/**
 * Best-effort parse of a `POST /` body as a batch Bundle — `undefined` when
 * the body isn't a bundle so a non-bundle POST at `/` falls through.
 */
const safeParseBundle = (body: string): RecordedBundleShape | undefined => {
  if (body === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as { readonly resourceType?: unknown }
  if (record.resourceType !== 'Bundle') return undefined
  return parsed
}

export {
  bundleTypes,
  clearRecorded,
  heldWireOf,
  idFromUrl,
  isResourceWrite,
  metaSourceOf,
  reads,
  routingServer,
  writes,
}
export type { RecordedRequest }
