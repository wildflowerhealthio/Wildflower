import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DateTime, Effect, Either, Layer, Schema } from 'effect'
import { buildSmartRouterContext } from 'fhir-r4-react/smart'
import { FhirResourceSchema } from 'fhir-r4/resources'
import { Snapshot, type SnapshotFile } from 'synthetic-data-core-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { SyntheticDataApp } from './app.tsx'
import { PUBLISHED_SNAPSHOT_ADDRESS, SYNTHETIC_DATA_SCOPE } from './config.ts'

/**
 * The app's own wiring, end to end: the real `buildSmartRouterContext` over a
 * stub transport, the real screen over a stubbed `fetch` serving a small
 * snapshot at the published address. The screen's behaviour is
 * `synthetic-data-react`'s test; what only this app can show is where each
 * request goes and what it carries:
 *
 * - the page starts at the published snapshot, and fetches its files with no
 *   credentials and no token;
 * - every write goes to the FHIR base the handshake named, with the granted
 *   bearer token;
 * - every type written is one `config.ts`'s scope string may create and
 *   update.
 */

const SERVER_URL = 'http://127.0.0.1:8080/fhir-r4'
const ACCESS_TOKEN = 'tok-abc'

interface RecordedWrite {
  readonly url: string
  readonly authorization: string | undefined
  readonly entryUrls: readonly string[]
}

let writes: RecordedWrite[]
let fetched: { readonly url: string; readonly init: RequestInit | undefined }[]

const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

/** A snapshot of one member: a Patient and an Observation filed on them. */
const snapshotFiles = (): readonly SnapshotFile.Any[] =>
  Either.getOrThrow(
    Snapshot.filesOf(
      Either.getOrThrow(
        Snapshot.assemble(DateTime.unsafeMake('2026-09-28T12:00:00.000Z'), 'abc123', [
          {
            member: { key: 'person-1', displayName: 'Sam Okoye', summary: 'One reading.' },
            resources: [
              decodeResource({ resourceType: 'Patient', id: 'p-1' }),
              decodeResource({
                resourceType: 'Observation',
                id: 'o-1',
                status: 'final',
                code: { text: 'Heart rate' },
                subject: { reference: 'Patient/p-1' },
              }),
            ],
          },
        ])
      )
    )
  )

beforeEach(() => {
  writes = []
  fetched = []
  const byUrl = new Map(
    snapshotFiles().map((file) => [new URL(file.path, PUBLISHED_SNAPSHOT_ADDRESS).href, file])
  )
  vi.stubGlobal('fetch', (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    fetched.push({ url, init })
    const file = byUrl.get(url)
    return Promise.resolve(
      file === undefined
        ? new Response('', { status: 404, statusText: 'Not Found' })
        : new Response(file._tag === 'Text' ? file.text : new Uint8Array(file.bytes), {
            status: 200,
          })
    )
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SyntheticDataApp', () => {
  it('loads the published snapshot into the connected server, with the token on the writes alone', async () => {
    const context = buildSmartRouterContext(
      { serverUrl: SERVER_URL, accessToken: ACCESS_TOKEN },
      recordingServer(),
      new QueryClient({ defaultOptions: { queries: { retry: false } } })
    )
    render(<SyntheticDataApp context={context} serverUrl={SERVER_URL} />)

    expect((await screen.findByRole('textbox', { name: 'Snapshot' })).getAttribute('value')).toBe(
      PUBLISHED_SNAPSHOT_ADDRESS
    )
    expect(screen.getByText(SERVER_URL)).toBeDefined()
    await userEvent.click(await screen.findByRole('button', { name: 'Load 1 person' }))
    await screen.findByText('Wrote 2 of 2 resources.')

    // The snapshot's files, from its own host, with nothing of the session on them.
    expect(fetched.map(({ url }) => url).toSorted()).toEqual([
      `${PUBLISHED_SNAPSHOT_ADDRESS}fhir/Observation/o-1.json`,
      `${PUBLISHED_SNAPSHOT_ADDRESS}fhir/Patient/p-1.json`,
      `${PUBLISHED_SNAPSHOT_ADDRESS}index.json`,
    ])
    for (const { init } of fetched) {
      expect(init?.credentials).toBe('omit')
      expect(init?.headers).toBeUndefined()
    }

    // The writes, at the FHIR base, bearing the token: the Patient before the
    // Observation filed on it.
    expect(writes).toEqual([
      {
        url: `${SERVER_URL}/`,
        authorization: `Bearer ${ACCESS_TOKEN}`,
        entryUrls: ['Patient/p-1'],
      },
      {
        url: `${SERVER_URL}/`,
        authorization: `Bearer ${ACCESS_TOKEN}`,
        entryUrls: ['Observation/o-1'],
      },
    ])

    // Every type written is one the scope string lets the app create and update.
    const scopes = SYNTHETIC_DATA_SCOPE.split(' ')
    for (const entryUrl of writes.flatMap((write) => write.entryUrls)) {
      const [resourceType] = entryUrl.split('/')
      expect(scopes).toContain(`system/${resourceType}.cu`)
    }
  })
})

/** Just what the test reads of a written batch bundle. */
const BundleBody = Schema.parseJson(
  Schema.Struct({
    entry: Schema.Array(Schema.Struct({ request: Schema.Struct({ url: Schema.String }) })),
  })
)

/** A stub FHIR server that records each batch bundle and answers every entry `201 Created`. */
const recordingServer = (): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const text =
        request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
      const { entry } = Schema.decodeUnknownSync(BundleBody)(text)
      writes.push({
        url: request.url,
        authorization: request.headers['authorization'],
        entryUrls: entry.map((one) => one.request.url),
      })
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              resourceType: 'Bundle',
              type: 'batch-response',
              entry: entry.map(() => ({ response: { status: '201 Created' } })),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
      )
    })
  )
