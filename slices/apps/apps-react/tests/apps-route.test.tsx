import { QueryClient } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { Effect } from 'effect'
import { type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import type * as QueriesModule from '../src/queries.ts'

// The route module imports `runAppsPublicEffect` (the loader's
// out-of-React effect runner that hits the network) from `queries.ts`.
// Stub *only* that runner — keep the real `appsListQueryOptions` and
// `APPS_LIST_QUERY_KEY` so the loader builds the genuine `queryKey` +
// `queryFn` pairing and the cache is keyed exactly as production does.
// `runAppsPublicEffect` is invoked as `run(effect)` inside the shared
// `queryFn`, so a stub that ignores the effect and resolves a fixed list
// is enough to exercise the loader's prefetch without a real request.
const { runStub } = vi.hoisted(() => ({
  runStub: vi.fn<(effect: unknown) => Promise<unknown>>(),
}))

vi.mock('../src/queries.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof QueriesModule>()
  return { ...actual, runAppsPublicEffect: runStub }
})

import { APPS_LIST_QUERY_KEY, type AppEntry } from '../src/queries.ts'
import { Route } from '../src/routes/_auth/apps/index.tsx'

// Helpers
const SAMPLE_APPS: readonly AppEntry[] = [
  { id: 'records', name: 'Records', requiresTunnel: false, kind: 'bundled', enabled: true },
  { id: 'portal', name: 'Portal', requiresTunnel: true, kind: 'custom', enabled: false },
]

// The loader's typed context only needs the `queryClient`; the route's
// standalone root declares exactly that shape.
const runLoader = (queryClient: QueryClient): Promise<unknown> => {
  const loader = Route.options.loader
  if (loader === undefined) {
    throw new Error('expected the apps route to declare a loader')
  }
  // The router calls the loader with a far richer match object at
  // runtime, but the apps loader only destructures `context.queryClient`
  // — so a minimal context is a faithful stand-in for this unit. The
  // cast narrows the loader's wide `LoaderFnContext` param down to the
  // single field the implementation reads; permitted in tests where it
  // doesn't reduce confidence in what's asserted.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const invoke = loader as (args: { context: { queryClient: QueryClient } }) => unknown
  return Promise.resolve(invoke({ context: { queryClient } }))
}

describe('apps route loader', () => {
  beforeEach(() => {
    runStub.mockReset()
  })

  test('prefetches the apps list into the shared QueryClient cache', async () => {
    // Arrange — a cold client and a runner that resolves the sample list.
    const queryClient = new QueryClient()
    runStub.mockResolvedValue(SAMPLE_APPS)

    // Act
    await runLoader(queryClient)

    // Assert — the loader populated the cache at the production key, so a
    // subsequent `useSuspenseQuery` resolves instantly instead of
    // suspending on navigation.
    expect(queryClient.getQueryData(APPS_LIST_QUERY_KEY)).toEqual(SAMPLE_APPS)
  })

  test('runs the ListApps effect through the public runner exactly once', async () => {
    // Arrange
    const queryClient = new QueryClient()
    runStub.mockResolvedValue(SAMPLE_APPS)

    // Act
    await runLoader(queryClient)

    // Assert — the loader drives the public runner with an Effect (the
    // `ListApps` call); we don't assert its internals, only that the
    // single prefetch went through the runner.
    expect(runStub).toHaveBeenCalledTimes(1)
    expect(Effect.isEffect(runStub.mock.calls[0]?.[0])).toBe(true)
  })

  test('surfaces a loader failure rather than caching a value', async () => {
    // Arrange — the runner rejects, modelling a failed ListApps request.
    const queryClient = new QueryClient()
    const failure = new Error('list apps failed')
    runStub.mockRejectedValue(failure)

    // Act + Assert — `ensureQueryData` rejects, so the router routes the
    // error to `errorComponent` (covered below) and nothing is cached.
    await expect(runLoader(queryClient)).rejects.toThrow('list apps failed')
    expect(queryClient.getQueryData(APPS_LIST_QUERY_KEY)).toBeUndefined()
  })
})

describe('apps route errorComponent', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('renders AsyncErrorView with the Apps title and the error message', () => {
    // Arrange
    const errorComponent = Route.options.errorComponent
    if (errorComponent === undefined || errorComponent === false) {
      throw new Error('expected the apps route to declare an errorComponent')
    }
    const error = new Error('boom while loading apps')
    // The route's `errorComponent` is typed as TanStack's
    // `ErrorRouteComponent`, which isn't directly assignable to a JSX
    // element factory; narrow it to the single prop the implementation
    // reads. Permitted in tests where it doesn't reduce confidence.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const ErrorView = errorComponent as (props: { readonly error: unknown }) => JSX.Element

    // Act — the router passes the thrown loader/query error to this
    // component; render it directly with the same contract.
    render(<ErrorView error={error} />)

    // Assert — same surface the previous inline CatchBoundary produced:
    // an "Apps" heading over the error text.
    expect(screen.getByRole('heading', { name: 'Apps' })).toBeTruthy()
    expect(screen.getByText('boom while loading apps')).toBeTruthy()
  })
})
