import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DateTime, Effect, Either, Layer, Schema } from 'effect'
import { buildSmartRouterContext } from 'fhir-r4-react/smart'
import { FhirResourceSchema } from 'fhir-r4/resources'
import { DataSet } from 'synthetic-data-core'
import { COMPLETE_HEADING, DEFAULT_DATA_SET_URL, WRITE_ORDER } from 'synthetic-data-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { SyntheticDataApp } from './app.tsx'
import { SYNTHETIC_DATA_SCOPE } from './config.ts'
import { rememberedDataSetUrl } from './data-set-url-memory.ts'

/**
 * The app's own wiring, end to end: its router context satisfies
 * `synthetic-data-react`'s `useRunAuthed`, its HTTP layer addresses the FHIR
 * server the SMART handshake named with the granted token, and the data set
 * is read from its own host with no token or cookies. Only the two transports are stubs
 * — the FHIR server's `HttpClient` and `globalThis.fetch` for the data set —
 * so the real `buildSmartRouterContext`, router, reads and writes run.
 *
 * The load flow itself — the people, the source file inlined, partial loads,
 * read failures — is `synthetic-data-react`'s `synthetic-data-screen.test.tsx`.
 */

const SERVER_URL = 'http://127.0.0.1:8080/fhir-r4'
const ACCESS_TOKEN = 'tok-abc'

/** One batch entry the FHIR server was sent, with the request's bearer header. */
interface RecordedWrite {
  readonly bundleUrl: string
  readonly authorization: string | undefined
  readonly method: string
  readonly url: string
}

let writes: RecordedWrite[]
/** Every URL the data set was read from. */
let dataSetUrls: string[]
/** The credentials mode of every data set read. */
let dataSetCredentials: (RequestCredentials | undefined)[]

const BatchBundleWire = Schema.parseJson(
  Schema.Struct({
    entry: Schema.Array(
      Schema.Struct({ request: Schema.Struct({ method: Schema.String, url: Schema.String }) })
    ),
  })
)

const bodyTextOf = (body: HttpClientRequest.HttpClientRequest['body']): string =>
  body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : ''

/** A FHIR server that records every batch entry and answers each `201 Created`. */
const recordingServer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    const bundle = Schema.decodeUnknownSync(BatchBundleWire)(bodyTextOf(request.body))
    for (const { request: entryRequest } of bundle.entry) {
      writes.push({
        bundleUrl: request.url,
        authorization: request.headers['authorization'],
        ...entryRequest,
      })
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            resourceType: 'Bundle',
            type: 'batch-response',
            entry: bundle.entry.map(() => ({ response: { status: '201 Created' } })),
          })
        )
      )
    )
  })
)

/** A one-person data set, a Patient and an Observation, as `DataSet.assemble` writes it. */
const DATA_SET_FILES = Either.getOrThrow(
  DataSet.assemble(DateTime.unsafeMake('2026-09-28T00:00:00.000Z'), 'abc1234', [
    {
      person: { key: 'person-a', displayName: 'Avery Example', summary: 'One reading.' },
      resources: [
        Schema.decodeUnknownSync(FhirResourceSchema)({ resourceType: 'Patient', id: 'patient-a' }),
        Schema.decodeUnknownSync(FhirResourceSchema)({
          resourceType: 'Observation',
          id: 'obs-a1',
          status: 'final',
          code: { text: 'Heart rate' },
          subject: { reference: 'Patient/patient-a' },
        }),
      ],
    },
  ])
)

/** Serve the data set at `root` through `globalThis.fetch`. */
const serveDataSetAt = (root: string): void => {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit): Promise<Response> => {
    dataSetUrls.push(url)
    dataSetCredentials.push(init?.credentials)
    const file = DATA_SET_FILES.find(({ path }) => `${root}${path}` === url)
    return Promise.resolve(
      file === undefined
        ? new Response('Not Found', { status: 404, statusText: 'Not Found' })
        : new Response(
            typeof file.contents === 'string' ? file.contents : new Uint8Array(file.contents)
          )
    )
  })
}

const mount = (): void => {
  const smartContext = buildSmartRouterContext(
    { serverUrl: SERVER_URL, accessToken: ACCESS_TOKEN },
    recordingServer
  )
  render(<SyntheticDataApp context={{ ...smartContext, serverUrl: SERVER_URL }} />)
}

beforeEach(() => {
  writes = []
  dataSetUrls = []
  dataSetCredentials = []
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SyntheticDataApp', () => {
  it('should read the published data set and load it into the FHIR server the handshake named', async () => {
    serveDataSetAt(DEFAULT_DATA_SET_URL)
    mount()

    expect(
      await screen.findByRole('heading', { name: 'Synthetic Data Loader', level: 1 })
    ).toBeTruthy()
    await userEvent.click(await screen.findByRole('button', { name: `Load into ${SERVER_URL}` }))

    expect(await screen.findByRole('heading', { name: COMPLETE_HEADING })).toBeTruthy()
    expect(writes.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'PUT Patient/patient-a',
      'PUT Observation/obs-a1',
    ])
    // Every write is addressed to the FHIR base and carries the granted token…
    for (const write of writes) {
      expect(write.bundleUrl.startsWith(SERVER_URL)).toBe(true)
      expect(write.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    }
    // …and the data set is read from its own host, never the FHIR server, and
    // with no credentials.
    expect(dataSetUrls.length).toBeGreaterThan(0)
    for (const url of dataSetUrls) expect(url.startsWith(DEFAULT_DATA_SET_URL)).toBe(true)
    expect(new Set(dataSetCredentials)).toEqual(new Set(['omit']))
  })

  it('should read the data set URL submitted, and keep it for this tab', async () => {
    const localDataSet = 'http://localhost:8000/'
    serveDataSetAt(localDataSet)
    mount()

    const field = await screen.findByLabelText('Data set URL')
    await userEvent.clear(field)
    await userEvent.type(field, localDataSet)
    await userEvent.click(screen.getByRole('button', { name: 'Read data set' }))

    expect(await screen.findByRole('checkbox', { name: /Avery Example/ })).toBeTruthy()
    expect(dataSetUrls).toContain(`${localDataSet}index.json`)
    expect(rememberedDataSetUrl(window.sessionStorage)).toBe(localDataSet)
  })

  // `src/config.ts` asks for writes on a fixed set of types, and the gatekeeper
  // seed allows exactly that string. A type the load orders but the scope
  // leaves out would be refused at authorize time on a real device.
  it('should request a write scope for every resource type a load writes', () => {
    const writableTypes = [...SYNTHETIC_DATA_SCOPE.matchAll(/system\/(\w+)\.cruds/g)].map(
      ([, resourceType]) => resourceType
    )
    expect(new Set(writableTypes)).toEqual(new Set(WRITE_ORDER))
    expect(writableTypes).toHaveLength(WRITE_ORDER.length)
  })
})
