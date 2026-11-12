import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, type RenderHookResult, renderHook, waitFor } from '@testing-library/react'
import { FhirR4ResourcesRouterContext, type RunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import type * as FhirR4React from '@wildflowerhealthio/fhir-r4-react'
import {
  type FhirR4ResourcesHttpApiClient,
  ResourceMatch,
} from '@wildflowerhealthio/fhir-r4/clients'
import { IdentifierAndReference, withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResourceWithId,
  LogicalReference,
  Patient,
} from '@wildflowerhealthio/fhir-r4/resources'
import type { ResolvedBatch } from '@wildflowerhealthio/importer-core'
import { ImportMatch, LinkPlan, SectionedList } from '@wildflowerhealthio/importer-fundamentals'
import { Effect, HashSet, Layer, Option, Schema } from 'effect'
import type { JSX, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { type ServerDiffState, useServerDiff } from './use-server-diff.ts'

/**
 * The server diff hook over a stub `runAuthed`: one that answers the diff
 * bundle (every id new unless a test puts a copy on the stub server), one that rejects
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
  storedOnServer = new Map()
  entriesAnswered = []
})

/** The time a failed classification's two retries take at TanStack's default backoff, with room. */
const RETRIES_TIMEOUT = 8_000

const patient = (id: string, identifier: readonly object[] = []): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
    resourceType: 'Patient',
    id,
    identifier,
  })

/** How many diff bundles the stub server has answered. */
let bundlesAnswered = 0

/** The `Type/id` of every GET entry the stub server has answered. */
let entriesAnswered: string[] = []

/** The records the stub server holds, by `Type/id`; reset by each test that uses it. */
let storedOnServer: ReadonlyMap<string, FhirResourceWithId> = new Map()

/** A HAR group holding `resources`, the other formats claiming nothing. */
const batchOf = (resources: readonly FhirResourceWithId[]): ResolvedBatch => {
  const groups = {
    har: {
      sectionedList: SectionedList.make([
        {
          title: 'Resources',
          rows: resources.map((resource, index) => ({
            reviewKey: `k-${index}`,
            title: resource.resourceType,
            isImplied: false,
            resource,
          })),
        },
      ]),
      notes: [],
      unreadableFiles: [],
      files: [{ id: '0:a.har', fileName: 'a.har', bytes: new Uint8Array([1]) }],
    },
  }
  return { groups, plan: LinkPlan.empty, decoded: { groups, unrecognizedFiles: [] } }
}

/**
 * A server that holds `storedOnServer`: a GET entry for one of them answers
 * it, every other is a 404, so its id is new.
 */
const stubServerLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    const text =
      request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
    bundlesAnswered += 1
    const entries = Schema.decodeUnknownSync(
      Schema.Struct({
        entry: Schema.Array(Schema.Struct({ request: Schema.Struct({ url: Schema.String }) })),
      })
    )(JSON.parse(text))
    entriesAnswered.push(...entries.entry.map(({ request: { url } }) => url))
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            resourceType: 'Bundle',
            type: 'batch-response',
            entry: entries.entry.map(({ request: { url } }) => {
              const stored = storedOnServer.get(url)
              return stored === undefined
                ? { response: { status: '404 Not Found' } }
                : { resource: stored, response: { status: '200 OK' } }
            }),
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      )
    )
  })
)

/**
 * A `runAuthed` that takes each call's fate from `fates` in order: `answer`
 * runs the effect against the stub server, `reject` fails the call as an
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
          FhirR4ResourcesRouterContext.sliceRuntimeLayer.pipe(Layer.provideMerge(stubServerLayer))
        ),
        Effect.scoped
      )
    )
  }
}

/** The hook over `batch` under `batchId`, under one query client, re-renderable with another pair. */
const renderDiff = (
  batch: ResolvedBatch,
  batchId: number,
  importMatch: Option.Option<ImportMatch.Type> = Option.none()
): RenderHookResult<ServerDiffState, { batch: ResolvedBatch; batchId: number }> => {
  const queryClient = new QueryClient()
  const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(
    ({ batch: current, batchId: id }: { batch: ResolvedBatch; batchId: number }) =>
      useServerDiff(current, id, importMatch),
    { initialProps: { batch, batchId }, wrapper: withQueryClient }
  )
}

/** The searched key of a Patient `identifier`, as the match records it. */
const searchedKey = (identifier: object): LogicalReference.Key => {
  const qualified = Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)(identifier)
  if (!IdentifierAndReference.isQualifiedIdentifier(qualified)) throw new Error('unreachable')
  return LogicalReference.key(LogicalReference.make('Patient', qualified))
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

  it('should compare a record with its matched copy under another id, and read nothing by id', async () => {
    // Arrange: the match searched the record's identifier and found one copy, stored elsewhere
    bundlesAnswered = 0
    currentRunAuthed = runAuthedWith([])
    const identifier = { system: 'https://source.example/id', value: 'p-1' }
    const imported = patient('p-1', [identifier])
    const qualified = Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)(identifier)
    if (!IdentifierAndReference.isQualifiedIdentifier(qualified)) throw new Error('unreachable')
    const importMatch: ImportMatch.Type = {
      ...ImportMatch.empty,
      foundByIdentifier: ResourceMatch.indexByIdentifier([patient('stored-9', [identifier])]),
      searchedIdentifiers: HashSet.make(
        LogicalReference.key(LogicalReference.make('Patient', qualified))
      ),
    }

    // Act
    const { result } = renderDiff(batchOf([imported]), 1, Option.some(importMatch))

    // Assert
    await waitFor(() => {
      expect(result.current).toMatchObject({ _tag: 'ready', refreshing: false })
    })
    expect(statusesOf(result.current)).toEqual(['unchanged'])
    expect(bundlesAnswered).toBe(0)
  })

  it('should read by id only the records the match did not search', async () => {
    // Arrange: a match that searched nothing
    bundlesAnswered = 0
    currentRunAuthed = runAuthedWith([])

    // Act
    const { result } = renderDiff(batchOf([patient('p-1')]), 1, Option.some(ImportMatch.empty))

    // Assert
    await waitFor(() => {
      expect(result.current).toMatchObject({ _tag: 'ready', refreshing: false })
    })
    expect(statusesOf(result.current)).toEqual(['new'])
    expect(bundlesAnswered).toBe(1)
  })
  it('should read by id a record whose identifiers the match searched and found nothing for', async () => {
    // Arrange: the match searched the record's identifier and found nothing,
    // while a copy whose identifiers were edited is stored under its own id
    bundlesAnswered = 0
    currentRunAuthed = runAuthedWith([])
    const identifier = { system: 'https://source.example/id', value: 'p-1' }
    const imported = patient('p-1', [identifier])
    storedOnServer = new Map([['Patient/p-1', patient('p-1')]])
    const importMatch: ImportMatch.Type = {
      ...ImportMatch.empty,
      searchedIdentifiers: HashSet.make(searchedKey(identifier)),
    }

    // Act
    const { result } = renderDiff(batchOf([imported]), 1, Option.some(importMatch))

    // Assert
    await waitFor(() => {
      expect(result.current).toMatchObject({ _tag: 'ready', refreshing: false })
    })
    expect(statusesOf(result.current)).toEqual(['changed'])
    expect(bundlesAnswered).toBe(1)
  })

  it('should read every record without a matched copy in one batch, and none with one', async () => {
    // Arrange: one record matched, one searched and not found, one not searched
    bundlesAnswered = 0
    currentRunAuthed = runAuthedWith([])
    const matchedIdentifier = { system: 'https://source.example/id', value: 'p-1' }
    const unmatchedIdentifier = { system: 'https://source.example/id', value: 'p-2' }
    const importMatch: ImportMatch.Type = {
      ...ImportMatch.empty,
      foundByIdentifier: ResourceMatch.indexByIdentifier([
        patient('stored-9', [matchedIdentifier]),
      ]),
      searchedIdentifiers: HashSet.make(
        searchedKey(matchedIdentifier),
        searchedKey(unmatchedIdentifier)
      ),
    }
    const batch = batchOf([
      patient('p-1', [matchedIdentifier]),
      patient('p-2', [unmatchedIdentifier]),
      patient('p-3'),
    ])

    // Act
    const { result } = renderDiff(batch, 1, Option.some(importMatch))

    // Assert
    await waitFor(() => {
      expect(result.current).toMatchObject({ _tag: 'ready', refreshing: false })
    })
    expect(statusesOf(result.current)).toEqual(['unchanged', 'new', 'new'])
    expect(bundlesAnswered).toBe(1)
    expect(entriesAnswered).toEqual(['Patient/p-2', 'Patient/p-3'])
  })
})
