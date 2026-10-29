import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, type RenderHookResult, renderHook, waitFor } from '@testing-library/react'
import { FhirR4ResourcesRouterContext, type RunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import type * as FhirR4React from '@wildflowerhealthio/fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResourceWithId, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import type { ResolvedBatch } from '@wildflowerhealthio/importer-core'
import { FormatDecode } from '@wildflowerhealthio/importer-fundamentals'
import { Effect, HashMap, Layer, Schema } from 'effect'
import type { JSX, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { type ServerDiffState, useServerDiff } from './use-server-diff.ts'

/**
 * The server diff hook over a stub `runAuthed`: one that answers the diff
 * bundle (every id new, since the stub server holds nothing), one that rejects
 * as an auth defect does, in the order the test lists, so the states a batch
 * passes through on a failed first diff and a change after it read back.
 */

vi.mock('@wildflowerhealthio/fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

let currentRunAuthed: RunAuthed

afterEach(() => {
  cleanup()
})

/** The time a failed classification's two retries take at TanStack's default backoff, with room. */
const RETRIES_TIMEOUT = 8_000

const patient = (id: string): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({ resourceType: 'Patient', id })

/** A HAR result holding `resources`, the other formats claiming nothing. */
const batchOf = (resources: readonly FhirResourceWithId[]): ResolvedBatch => ({
  formats: {
    har: {
      ...FormatDecode.emptyResult('har'),
      title: 'a.har',
      files: [{ id: '0:a.har', fileName: 'a.har', bytes: new Uint8Array([1]) }],
      decoded: {
        sections: [
          {
            title: 'Resources',
            resources: resources.map((resource, index) => ({
              key: `k-${index}`,
              title: resource.resourceType,
              resource,
            })),
          },
        ],
        notes: [],
      },
    },
    'lifelabs-pdf': FormatDecode.emptyResult('lifelabs-pdf'),
    dicom: FormatDecode.emptyResult('dicom'),
  },
  unrecognizedFiles: [],
  linkedRecords: [],
  linkTargetsByReferentKey: HashMap.empty(),
  unlinkedMentionsByFormatKind: HashMap.empty(),
})

/** A server that holds nothing: every GET entry of the diff bundle is a 404, so every id is new. */
const emptyServerLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    const text =
      request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
    const entries = Schema.decodeUnknownSync(
      Schema.Struct({ entry: Schema.Array(Schema.Unknown) })
    )(JSON.parse(text))
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            resourceType: 'Bundle',
            type: 'batch-response',
            entry: entries.entry.map(() => ({ response: { status: '404 Not Found' } })),
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      )
    )
  })
)

/**
 * A `runAuthed` that takes each call's fate from `fates` in order: `answer`
 * runs the effect against the empty server, `reject` fails the call as an
 * auth defect does. Past the list, every call answers.
 */
const runAuthedWith = (fates: readonly ('answer' | 'reject')[]): RunAuthed => {
  let calls = 0
  return <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient | FhirR4ResourcesHttpApiClient>
  ): Promise<A> => {
    const fate = fates[calls] ?? 'answer'
    calls += 1
    if (fate === 'reject') return Promise.reject(new Error('not signed in'))
    return Effect.runPromise(
      effect.pipe(
        Effect.provide(
          FhirR4ResourcesRouterContext.sliceRuntimeLayer.pipe(Layer.provideMerge(emptyServerLayer))
        ),
        Effect.scoped
      )
    )
  }
}

/** The hook over `batch` under `batchId`, under one query client, re-renderable with another pair. */
const renderDiff = (
  batch: ResolvedBatch,
  batchId: number
): RenderHookResult<ServerDiffState, { batch: ResolvedBatch; batchId: number }> => {
  const queryClient = new QueryClient()
  const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(
    ({ batch: current, batchId: id }: { batch: ResolvedBatch; batchId: number }) =>
      useServerDiff(current, id),
    { initialProps: { batch, batchId }, wrapper: withQueryClient }
  )
}

const statusesOf = (state: ServerDiffState): readonly string[] =>
  state._tag === 'loading'
    ? []
    : [...(state.comparisons.get('har')?.values() ?? [])].map(({ status }) => status)

describe('useServerDiff', () => {
  it('should keep a changed batch’s panel up on the verdicts it last settled on, then swap in its own', async () => {
    currentRunAuthed = runAuthedWith(['answer', 'answer'])
    const first = batchOf([patient('p-1')])
    const { result, rerender } = renderDiff(first, 1)
    await waitFor(() => {
      expect(result.current).toMatchObject({ _tag: 'ready', refreshing: false })
    })

    rerender({ batch: batchOf([patient('p-1'), patient('p-2')]), batchId: 1 })

    // Never `loading` again for this batch: the changed batch reads the first verdicts while its own load.
    expect(result.current).toMatchObject({ _tag: 'ready', refreshing: true })
    expect(statusesOf(result.current)).toEqual(['new', 'new'])
    await waitFor(() => {
      expect(result.current).toMatchObject({ _tag: 'ready', refreshing: false })
    })
  })

  it('should report a diff that failed after its retries, and keep the panel up on a change after it', async () => {
    currentRunAuthed = runAuthedWith(['reject', 'reject', 'reject', 'answer'])
    const { result, rerender } = renderDiff(batchOf([patient('p-1')]), 1)
    await waitFor(
      () => {
        expect(result.current._tag).toBe('error')
      },
      { timeout: RETRIES_TIMEOUT }
    )
    expect(statusesOf(result.current)).toEqual(['new'])

    rerender({ batch: batchOf([patient('p-1'), patient('p-2')]), batchId: 1 })

    expect(result.current).toMatchObject({ _tag: 'ready', refreshing: true })
    expect(statusesOf(result.current)).toEqual(['new', 'new'])
    await waitFor(() => {
      expect(result.current).toMatchObject({ _tag: 'ready', refreshing: false })
    })
  })

  it('should carry nothing over to a fresh pick', async () => {
    currentRunAuthed = runAuthedWith(['answer', 'answer'])
    const { result, rerender } = renderDiff(batchOf([patient('p-1')]), 1)
    await waitFor(() => {
      expect(result.current).toMatchObject({ _tag: 'ready', refreshing: false })
    })

    rerender({ batch: batchOf([patient('p-9')]), batchId: 2 })

    expect(result.current._tag).toBe('loading')
    await waitFor(() => {
      expect(result.current).toMatchObject({ _tag: 'ready', refreshing: false })
    })
  })
})
