import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Encoding, Layer, Schema } from 'effect'
import { FhirR4ResourcesRouterContext, type RunAuthed } from 'fhir-r4-react'
import type * as FhirR4React from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  DATA_SET_URL,
  dataSetFixture,
  HAR_BYTES,
  PEOPLE,
  staticHostOf,
  type StaticHost,
} from './data-set.test-helpers.ts'
import { COMPLETE_HEADING, PARTIAL_HEADING } from './load-results.tsx'
import { SyntheticDataScreen } from './synthetic-data-screen.tsx'

/**
 * The screen end to end over a fixture data set on an in-memory static host
 * and a recording FHIR server: only the router seam (`useRunAuthed`) is
 * replaced, so the real reads, `persistBatchBundle` and the typed FHIR client
 * put every write in one log.
 */

vi.mock('fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

const SERVER_URL = 'http://127.0.0.1:8080/fhir-r4'

let currentRunAuthed: RunAuthed
let queryClient: QueryClient
/** Every batch entry the FHIR server was sent, in order. */
let writes: { readonly method: string; readonly url: string; readonly resource: unknown }[]
/** How many batch bundles the FHIR server was sent. */
let bundleCount: number

const BatchBundleWire = Schema.parseJson(
  Schema.Struct({
    entry: Schema.Array(
      Schema.Struct({
        request: Schema.Struct({ method: Schema.String, url: Schema.String }),
        resource: Schema.Unknown,
      })
    ),
  })
)

const bodyTextOf = (body: HttpClientRequest.HttpClientRequest['body']): string =>
  body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : ''

/**
 * A FHIR server that records every batch entry and answers each `201 Created`,
 * or `422 Unprocessable Entity` with a diagnostic for the urls `rejects` names.
 */
const recordingServer = (rejects: ReadonlySet<string> = new Set()): RunAuthed => {
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const bundle = Schema.decodeUnknownSync(BatchBundleWire)(bodyTextOf(request.body))
      bundleCount += 1
      const entry = bundle.entry.map(({ request: entryRequest, resource }) => {
        writes.push({ ...entryRequest, resource })
        return rejects.has(entryRequest.url)
          ? {
              response: {
                status: '422 Unprocessable Entity',
                outcome: {
                  resourceType: 'OperationOutcome',
                  issue: [
                    { severity: 'error', code: 'invalid', diagnostics: 'Rejected in a test' },
                  ],
                },
              },
            }
          : { response: { status: '201 Created' } }
      })
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ resourceType: 'Bundle', type: 'batch-response', entry }), {
            headers: { 'content-type': 'application/fhir+json' },
          })
        )
      )
    })
  )
  return <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient | FhirR4ResourcesHttpApiClient>
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          FhirR4ResourcesRouterContext.sliceRuntimeLayer.pipe(Layer.provideMerge(httpLayer))
        )
      )
    )
}

const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)

const mount = (host: StaticHost, dataSetUrl = DATA_SET_URL): { onChange: () => void } => {
  const onChange = vi.fn()
  render(
    <SyntheticDataScreen
      serverUrl={SERVER_URL}
      dataSetUrl={dataSetUrl}
      onDataSetUrlChange={onChange}
      fetchUrl={host.fetch}
    />,
    { wrapper: withQueryClient }
  )
  return { onChange }
}

const loadButton = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: `Load into ${SERVER_URL}` })

/** Every written `Type/id`, sorted. */
const writtenLabels = (): readonly string[] => writes.map(({ url }) => url).toSorted()

beforeEach(() => {
  currentRunAuthed = recordingServer()
  queryClient = new QueryClient()
  writes = []
  bundleCount = 0
})

afterEach(() => {
  cleanup()
})

describe('SyntheticDataScreen', () => {
  it('should list each person with what their files hold, everyone picked', async () => {
    const { files } = await dataSetFixture()
    mount(staticHostOf(files))

    const people = await screen.findByRole('group', { name: 'People' })
    const boxes = within(people).getAllByRole('checkbox')
    expect(boxes.map((box) => box.matches(':checked'))).toEqual([true, true])
    expect(people.textContent).toContain(PEOPLE[0].displayName)
    expect(people.textContent).toContain(PEOPLE[0].summary)
    expect(people.textContent).toContain(
      '4 resources (2 Observation, 1 DocumentReference, 1 Patient) · 1 source file'
    )
    expect(people.textContent).toContain(
      '3 resources (1 DocumentReference, 1 Observation, 1 Patient) · 1 source file'
    )
  })

  it('should write everyone’s resources once each, the shared source file with its HAR inline', async () => {
    const { files, sourceFile, resourcesByLabel } = await dataSetFixture()
    mount(staticHostOf(files))

    await userEvent.click(await loadButton())

    expect(await screen.findByRole('heading', { name: COMPLETE_HEADING })).toBeTruthy()
    expect(screen.getByText(/^Wrote 6 of 6 resources for/).textContent).toBe(
      `Wrote 6 of 6 resources for Avery Example, Blair Example to ${SERVER_URL}.`
    )
    expect(writtenLabels()).toEqual(
      [
        `DocumentReference/${sourceFile.id}`,
        'Observation/obs-a1',
        'Observation/obs-a2',
        'Observation/obs-b1',
        'Patient/patient-a',
        'Patient/patient-b',
      ].toSorted()
    )
    expect(writes.every(({ method }) => method === 'PUT')).toBe(true)
    // Patients first, then the source file their records name, then the rest.
    expect(writes.map(({ url }) => url.split('/')[0])).toEqual([
      'Patient',
      'Patient',
      'DocumentReference',
      'Observation',
      'Observation',
      'Observation',
    ])
    // Each resource goes on the wire exactly as its import would write it:
    // the source file with its HAR as `data`, and no `url`.
    for (const { url, resource } of writes) {
      expect(resource).toEqual(JSON.parse(JSON.stringify(resourcesByLabel.get(url))))
    }
    expect(sourceFile.content[0]?.attachment.data).toBe(Encoding.encodeBase64(HAR_BYTES))
  })

  it('should write only the people left picked', async () => {
    const { files, sourceFile } = await dataSetFixture()
    mount(staticHostOf(files))

    await userEvent.click(await screen.findByRole('checkbox', { name: /Avery Example/ }))
    await userEvent.click(await loadButton())

    await screen.findByRole('heading', { name: COMPLETE_HEADING })
    expect(writtenLabels()).toEqual(
      [`DocumentReference/${sourceFile.id}`, 'Observation/obs-b1', 'Patient/patient-b'].toSorted()
    )
    expect(screen.getByRole('status').textContent).toBe(
      `Wrote 3 of 3 resources for Blair Example to ${SERVER_URL}.`
    )

    // Picking again after the load leaves its results naming who it loaded.
    await userEvent.click(screen.getByRole('checkbox', { name: /Avery Example/ }))
    expect(screen.getByRole('status').textContent).toBe(
      `Wrote 3 of 3 resources for Blair Example to ${SERVER_URL}.`
    )
  })

  it('should not offer a load with no one picked', async () => {
    const { files } = await dataSetFixture()
    mount(staticHostOf(files))

    await userEvent.click(await screen.findByRole('checkbox', { name: /Avery Example/ }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /Blair Example/ }))

    expect((await loadButton()).hasAttribute('disabled')).toBe(true)
  })

  it('should report a rejected resource as a partial load, with the server’s diagnostic', async () => {
    const { files } = await dataSetFixture()
    currentRunAuthed = recordingServer(new Set(['Observation/obs-a2']))
    mount(staticHostOf(files))

    await userEvent.click(await loadButton())

    expect(await screen.findByRole('heading', { name: PARTIAL_HEADING })).toBeTruthy()
    const failure = screen.getByRole('alert')
    expect(failure.textContent).toContain('422 Unprocessable Entity · 1 resource')
    expect(failure.textContent).toContain('Observation/obs-a2')
    expect(failure.textContent).toContain('Rejected in a test')
    expect(screen.getByRole('status').textContent).toMatch(/^Wrote 5 of 6 resources/)
  })

  it('should write nothing when a file cannot be read, and say which', async () => {
    const { files } = await dataSetFixture()
    mount(staticHostOf(files, new Map([['har/family.har', undefined]])))

    await userEvent.click(await loadButton())

    expect(
      await screen.findByText(
        'Could not load the data set: har/family.har: the host answered 404 Not Found.'
      )
    ).toBeTruthy()
    expect(bundleCount).toBe(0)
  })

  it('should show how far a load has read, with the people and the load locked', async () => {
    const { files } = await dataSetFixture()
    const host = staticHostOf(files)
    // The HAR never arrives, so the load stays reading the source file.
    const stalledHost: StaticHost = {
      ...host,
      fetch: (url) =>
        url.endsWith('/har/family.har') ? new Promise<Response>(() => undefined) : host.fetch(url),
    }
    mount(stalledHost)

    await userEvent.click(await loadButton())

    expect((await screen.findByRole('status')).textContent).toBe('Reading 5 of 6 files…')
    expect(screen.getByRole('progressbar', { name: 'Reading 5 of 6 files…' })).toBeTruthy()
    for (const box of screen.getAllByRole('checkbox')) expect(box.matches(':disabled')).toBe(true)
    expect((await loadButton()).hasAttribute('disabled')).toBe(true)
    expect(bundleCount).toBe(0)
  })

  it('should say why the data set cannot be read when it has no index.json', async () => {
    const { files } = await dataSetFixture()
    mount(staticHostOf(files, new Map([['index.json', undefined]])))

    expect(
      await screen.findByText(
        'Could not load the data set: index.json: the host answered 404 Not Found.'
      )
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: `Load into ${SERVER_URL}` })).toBeNull()
  })

  it('should report a URL that is not a data set root without reading it', async () => {
    const { files } = await dataSetFixture()
    const host = staticHostOf(files)
    mount(host, 'file:///home/data/')

    expect(screen.getByRole('alert').textContent).toBe('A data set is read over https: or http:.')
    await waitFor(() => {
      expect(host.requestedUrls).toEqual([])
    })
  })

  it('should hand the submitted URL to its caller', async () => {
    const { files } = await dataSetFixture()
    const { onChange } = mount(staticHostOf(files))

    const field = screen.getByLabelText('Data set URL')
    await userEvent.clear(field)
    await userEvent.type(field, ' http://localhost:8000/ ')
    await userEvent.click(screen.getByRole('button', { name: 'Read data set' }))

    expect(onChange).toHaveBeenCalledWith('http://localhost:8000/')
  })
})
