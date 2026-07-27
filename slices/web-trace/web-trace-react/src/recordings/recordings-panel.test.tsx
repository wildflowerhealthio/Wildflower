import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer, pipe } from 'effect'
import { FhirR4ResourcesRouterContext, type RunAuthed } from 'fhir-r4-react'
import type * as FhirR4React from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { traceExchangeToWire } from 'web-trace-core/codec'
import { traceExchange } from 'web-trace-core/test-helpers'

import { RecordingsPanel } from './recordings-panel.tsx'

/**
 * Drives the whole recordings tab over the real
 * query → runner → FHIR-client → HttpClient path, with a stub `HttpClient`
 * serving canned searchset bundles. Only the router seam is replaced: the
 * authed runner normally comes from router context, which a mounted slice
 * component has no way to provide on its own.
 */
vi.mock('fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

let currentRunAuthed: RunAuthed
let requestCount = 0

beforeEach(() => {
  requestCount = 0
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RecordingsPanel', () => {
  it('should list the device recordings once the first page arrives', async () => {
    // Arrange
    serve([
      searchset([
        wire({ sessionId: 'morning', requestId: 'a', url: 'https://portal.example.org/one' }),
        wire({ sessionId: 'evening', requestId: 'b', url: 'https://api.example.com/two' }),
      ]),
    ])

    // Act
    render(<RecordingsPanel />, { wrapper: withQueryClient })

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
    })
    expect(screen.getByRole('button', { name: /evening/ })).toBeDefined()
  })

  it('should open a session and show its exchanges with their captured URLs', async () => {
    // Arrange
    const url = 'https://portal.example.org/api/v2/patients/8f14e45f?name=Ada%20Lovelace'
    serve([searchset([wire({ sessionId: 'morning', requestId: 'a', url })])])
    render(<RecordingsPanel />, { wrapper: withQueryClient })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
    })

    // Act
    await userEvent.click(screen.getByRole('button', { name: /morning/ }))

    // Assert — raw, as recorded; the viewer does not redact
    expect(screen.getByText(url)).toBeDefined()
  })

  it('should return to the session list from an opened session', async () => {
    // Arrange
    serve([searchset([wire({ sessionId: 'morning', requestId: 'a' })])])
    render(<RecordingsPanel />, { wrapper: withQueryClient })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /morning/ }))

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'All recordings' }))

    // Assert — the exchange list and its filters are gone, the session list is back
    expect(screen.queryByLabelText('URL contains')).toBeNull()
    expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
  })

  it('should merge a session that straddles a page boundary when more is loaded', async () => {
    // Arrange
    serve([
      searchset([wire({ sessionId: 'morning', requestId: 'a' })], 'cursor-2'),
      searchset([wire({ sessionId: 'morning', requestId: 'b' })]),
    ])
    render(<RecordingsPanel />, { wrapper: withQueryClient })
    await waitFor(() => {
      expect(screen.getByText('1+ exchanges')).toBeDefined()
    })

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Load more recordings' }))

    // Assert — one row, exact count, and no further page offered
    await waitFor(() => {
      expect(screen.getByText('2 exchanges')).toBeDefined()
    })
    expect(screen.getAllByRole('button', { name: /morning/ })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Load more recordings' })).toBeNull()
  })

  it('should report a failed read instead of showing an empty device', async () => {
    // Arrange
    serveFailure()

    // Act
    render(<RecordingsPanel />, { wrapper: withQueryClient })

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })
    expect(screen.queryByText('No recordings on this device.')).toBeNull()
  })

  it('should hand a chosen exchange to its host', async () => {
    // Arrange
    const onSelectExchange = vi.fn()
    serve([
      searchset([
        wire({ sessionId: 'morning', requestId: 'a', url: 'https://portal.example.org/one' }),
      ]),
    ])
    render(<RecordingsPanel onSelectExchange={onSelectExchange} />, { wrapper: withQueryClient })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /morning/ }))

    // Act
    await userEvent.click(screen.getByRole('button', { name: /portal\.example\.org\/one/ }))

    // Assert
    expect(onSelectExchange).toHaveBeenCalledTimes(1)
    expect(onSelectExchange.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'morning',
      requestId: 'a',
    })
  })
})

// Helpers

const wire = (overrides: Parameters<typeof traceExchange>[0]): unknown =>
  traceExchangeToWire(traceExchange(overrides))

const searchset = (resources: readonly unknown[], nextCursor?: string): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link:
    nextCursor === undefined
      ? []
      : [
          {
            relation: 'next',
            url: `https://device.local/fhir-r4/DocumentReference?_pageToken=${nextCursor}`,
          },
        ],
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

/** A fresh `QueryClient` per render, with retries off so a failure surfaces at once. */
const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
)
