import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { DateTime, Effect, Layer, Schema } from 'effect'
import { FhirR4ResourcesRouterContext, type RunAuthed } from 'fhir-r4-react'
import type * as FhirR4React from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'web-trace-core/codec'

import { useHarArchivesQuery } from '../queries/har-archives.ts'
import { useUploadHar } from './upload-har.ts'

/**
 * The upload mutation, driven over the real
 * mutation → runner → FHIR-client → `HttpClient` path with a *stateful* stub
 * transport that remembers each PUT and answers a later search with it. That is
 * what makes "the list is invalidated and the new archive appears" an observed
 * fact rather than a spy assertion: the list query, mounted alongside, refetches
 * on invalidation and finds the just-uploaded archive.
 */

vi.mock('fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

let currentRunAuthed: RunAuthed
let queryClient: QueryClient
/** The archive wires the stub server has stored, keyed by the PUT that created them. */
let stored: Map<string, unknown>

beforeEach(() => {
  stored = new Map()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  currentRunAuthed = statefulServer()
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.restoreAllMocks()
})

describe('useUploadHar', () => {
  it('should upload an archive and make it appear in the list, which it invalidates', async () => {
    // Arrange — the list is empty before any upload
    const { result } = renderHook(() => ({ upload: useUploadHar(), list: useHarArchivesQuery() }), {
      wrapper: withQueryClient,
    })
    await waitFor(() => {
      expect(result.current.list.isSuccess).toBe(true)
    })
    expect(result.current.list.data?.pages.flatMap((page) => page.archives)).toHaveLength(0)

    // Act
    const id = await result.current.upload.mutateAsync({
      fileName: 'portal-session.har',
      bytes: new Uint8Array([1, 2, 3, 4]),
    })

    // Assert — the list refetched (invalidation) and the new archive is in it
    await waitFor(() => {
      const rows = result.current.list.data?.pages.flatMap((page) => page.archives) ?? []
      expect(rows.map((row) => row.id)).toContain(id)
    })
  })

  it('should mint a fresh id per upload, so the same bytes become two documents', async () => {
    // Arrange
    const { result } = renderHook(() => useUploadHar(), { wrapper: withQueryClient })
    const bytes = new Uint8Array([1, 2, 3, 4])

    // Act — the same bytes, uploaded twice
    const first = await result.current.mutateAsync({ fileName: 'same.har', bytes })
    const second = await result.current.mutateAsync({ fileName: 'same.har', bytes })

    // Assert — two distinct documents, not one silently overwriting the other
    expect(first).not.toBe(second)
    expect(stored.has(first)).toBe(true)
    expect(stored.has(second)).toBe(true)
    expect(stored.size).toBe(2)
  })
})

// Helpers

/** Text as base64, for the synthesized attachment the search echoes back. */
const base64 = Schema.encodeSync(Schema.StringFromBase64)

/** The last path segment of a request URL — a resource's logical id on a PUT. */
const idFromUrl = (url: string): string => {
  const path = url.split('?')[0] ?? url
  const segments = path.split('/')
  return segments[segments.length - 1] ?? ''
}

/** A minimal archive `DocumentReference` wire, enough for the list to row it. */
const storedArchiveWire = (id: string): unknown => {
  const coding = [{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }]
  const iso = DateTime.formatIso(DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z')))
  return {
    resourceType: 'DocumentReference',
    id,
    status: 'current',
    type: { coding },
    category: [{ coding }],
    date: iso,
    content: [
      {
        attachment: {
          contentType: 'application/json',
          data: base64('{"log":{"version":"1.2","entries":[]}}'),
          title: 'portal-session.har',
          creation: iso,
        },
      },
    ],
  }
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const searchset = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [],
})

/**
 * A transport that stores each PUT under its minted id and answers a search with
 * everything stored so far — the smallest thing that lets a refetch observe an
 * upload.
 */
const statefulServer = (): RunAuthed => {
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      if (request.method === 'PUT') {
        const id = idFromUrl(request.url)
        stored.set(id, storedArchiveWire(id))
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, jsonResponse(storedArchiveWire(id)))
        )
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, jsonResponse(searchset([...stored.values()])))
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
        ),
        Effect.scoped
      )
    )
}

const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)
