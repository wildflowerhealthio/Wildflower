import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer, pipe, Schema } from 'effect'
import { FhirR4ResourcesRouterContext, type RunAuthed } from 'fhir-r4-react'
import type * as FhirR4React from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { DocumentsPanel } from './documents-panel.tsx'

/**
 * Drives the whole documents tab over the real
 * query → runner → FHIR-client path with a stub `HttpClient`. Only the router
 * seam is replaced, exactly as in `recordings-panel.test.tsx`.
 *
 * The load-bearing one here is the shared attachment viewer: `fromFhirAttachment`
 * had no production caller until this panel, so "one viewer, two adapters" was
 * a claim about the shape of the code. Walking down to a document's content and
 * finding the *same* viewer's output is what turns it into an observed fact.
 */
vi.mock('fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

let currentRunAuthed: RunAuthed
let requestCount = 0
let sentRequests: HttpClientRequest.HttpClientRequest[] = []
let queryClient: QueryClient

beforeEach(() => {
  requestCount = 0
  sentRequests = []
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.restoreAllMocks()
})

describe('DocumentsPanel', () => {
  it('should list documents of every category, not only web traces', async () => {
    // Arrange — one clinical document and one trace resource. The recordings
    // tab shows only the second; this tab must show both.
    serve([
      searchset([
        documentWire({
          id: 'discharge-1',
          title: 'Discharge summary',
          category: [{ coding: [{ system: 'http://example.org/docs', code: 'discharge' }] }],
        }),
        documentWire({
          id: 'trace-1',
          title: 'GET https://portal.example.org/api/v2/patients',
          category: [
            { coding: [{ system: 'http://wildflower.health/CodeSystem', code: 'web-trace' }] },
          ],
        }),
      ]),
    ])

    // Act
    render(<DocumentsPanel />, { wrapper: withQueryClient })

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Discharge summary/ })).toBeDefined()
    })
    expect(screen.getByRole('button', { name: /portal\.example\.org/ })).toBeDefined()
  })

  it('should render a document attachment through the shared attachment viewer', async () => {
    // Arrange — the JSON body renders re-indented, which is `AttachmentViewer`'s
    // own behaviour and not something this panel implements.
    serve([
      searchset([
        documentWire({
          id: 'doc-1',
          title: 'Patient bundle',
          contentType: 'application/json',
          data: base64('{"resourceType":"Patient","id":"9f3"}'),
        }),
      ]),
    ])
    render(<DocumentsPanel />, { wrapper: withQueryClient })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Patient bundle/ })).toBeDefined()
    })

    // Act
    await userEvent.click(screen.getByRole('button', { name: /Patient bundle/ }))

    // Assert — the same viewer the recordings tab mounts: its `aria-label`
    // region, its content-type chip, and its re-indented JSON. The identity
    // normalizer keeps Testing Library from collapsing the indentation those
    // assertions exist to check.
    const viewer = screen.getByRole('region', { name: 'Attachment' })
    expect(within(viewer).getByText('application/json')).toBeDefined()
    expect(
      within(viewer).getByText('{\n  "resourceType": "Patient",\n  "id": "9f3"\n}', {
        normalizer: (text: string): string => text,
      })
    ).toBeDefined()
  })

  it('should name a by-reference attachment rather than fetching it', async () => {
    // Arrange — an attachment with a `url` and no `data`. `TraceBody` cannot
    // express this case at all, which is why the viewer takes the adapted shape.
    serve([
      searchset([
        documentWire({
          id: 'doc-1',
          title: 'Scanned referral',
          contentType: 'application/pdf',
          url: 'https://files.example.org/referral.pdf',
        }),
      ]),
    ])
    render(<DocumentsPanel />, { wrapper: withQueryClient })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Scanned referral/ })).toBeDefined()
    })

    // Act
    await userEvent.click(screen.getByRole('button', { name: /Scanned referral/ }))

    // Assert — named, not retrieved. No network egress at any point is the
    // premise of the app, so the second request never happens.
    expect(screen.getByText(/held at https:\/\/files\.example\.org\/referral\.pdf/)).toBeDefined()
    expect(screen.getByText(/does not fetch it/)).toBeDefined()
    expect(sentRequests).toHaveLength(1)
  })

  it('should re-search the server when a filter changes rather than narrowing the loaded page', async () => {
    // Arrange
    serve([
      searchset([documentWire({ id: 'doc-1', title: 'Everything' })]),
      searchset([documentWire({ id: 'doc-2', title: 'Only superseded' })]),
    ])
    render(<DocumentsPanel />, { wrapper: withQueryClient })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Everything/ })).toBeDefined()
    })

    // Act
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'superseded')

    // Assert — a second search went out carrying the status, and the rows are
    // the server's answer to it. Filtering the loaded page would issue no
    // request at all.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Only superseded/ })).toBeDefined()
    })
    expect(sentRequests).toHaveLength(2)
    expect(paramsOf(1)['status']).toBe('superseded')
  })

  it('should say a search matched nothing rather than claiming the device is empty', async () => {
    // Arrange
    serve([searchset([documentWire({ id: 'doc-1', title: 'Everything' })]), searchset([])])
    render(<DocumentsPanel />, { wrapper: withQueryClient })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Everything/ })).toBeDefined()
    })

    // Act
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'entered-in-error')

    // Assert — "no documents on this device" would be a claim about the device;
    // what actually happened is that this search matched nothing.
    await waitFor(() => {
      expect(screen.getByText('No documents on this device match this search.')).toBeDefined()
    })
  })

  it('should render nothing rather than an empty list when the read failed', async () => {
    // Arrange
    serveFailure()

    // Act
    render(<DocumentsPanel />, { wrapper: withQueryClient })

    // Assert — a failed read only means the device was never successfully
    // asked, so the banner is the whole answer.
    await waitFor(() => {
      expect(screen.queryByText('No documents on this device.')).toBeNull()
    })
    expect(screen.queryByText('No documents on this device match this search.')).toBeNull()
  })

  it('should return to the list from an open document', async () => {
    // Arrange
    serve([searchset([documentWire({ id: 'doc-1', title: 'Patient bundle' })])])
    render(<DocumentsPanel />, { wrapper: withQueryClient })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Patient bundle/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /Patient bundle/ }))

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'All documents' }))

    // Assert — the filter bar is back, which the detail does not carry
    expect(screen.getByLabelText('Category')).toBeDefined()
  })
})

// Helpers

/** Text as base64, the way the capture side stores a body. */
const base64 = Schema.encodeSync(Schema.StringFromBase64)

/** A `DocumentReference` on the wire, with only what a test cares to state. */
const documentWire = (fields: {
  readonly id: string
  readonly title?: string
  readonly category?: readonly unknown[]
  readonly contentType?: string
  readonly data?: string
  readonly url?: string
}): unknown => ({
  resourceType: 'DocumentReference',
  id: fields.id,
  status: 'current',
  ...(fields.category === undefined ? {} : { category: fields.category }),
  content: [
    {
      attachment: {
        contentType: fields.contentType ?? 'application/json',
        ...(fields.title === undefined ? {} : { title: fields.title }),
        ...(fields.data === undefined ? {} : { data: fields.data }),
        ...(fields.url === undefined ? {} : { url: fields.url }),
      },
    },
  ],
})

const searchset = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [],
})

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const runAuthedOver = (httpLayer: Layer.Layer<HttpClient.HttpClient>): RunAuthed => {
  return <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient | FhirR4ResourcesHttpApiClient>
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          pipe(FhirR4ResourcesRouterContext.sliceRuntimeLayer, Layer.provideMerge(httpLayer))
        ),
        Effect.scoped
      )
    )
}

/** Answers the nth search with the nth bundle. A request past the end dies. */
const serve = (bodies: readonly unknown[]): void => {
  currentRunAuthed = runAuthedOver(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const body = bodies[requestCount]
        requestCount += 1
        sentRequests.push(request)
        if (body === undefined) return Effect.die(new Error('unexpected extra request'))
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(body)))
      })
    )
  )
}

const serveFailure = (): void => {
  currentRunAuthed = runAuthedOver(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 })))
      )
    )
  )
}

/** The search parameters of the nth recorded request, as a plain lookup. */
const paramsOf = (index: number): Readonly<Record<string, string | undefined>> => {
  const request = sentRequests[index]
  if (request === undefined) throw new Error(`no request recorded at index ${index}`)
  return Object.fromEntries(request.urlParams)
}

/** The test's own `QueryClient`, with retries off so a failure surfaces at once. */
const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)
