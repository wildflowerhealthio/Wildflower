import { QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { GRANTS_QUERY_KEY } from '../../../queries/index.ts'
import { AccessIndexErrorView } from './index.tsx'

/**
 * Locks in the recovery path of the `/settings/gatekeeper/` route's
 * `errorComponent`. The Retry button used to call only `reset` — which clears
 * the `CatchBoundary`'s local error state but does NOT re-run the route loader,
 * so recovery rode implicitly on `useGrantsQuery` (`useSuspenseQuery`)
 * refetching. This pins the explicit fix: Retry must invalidate the grants
 * query (so the suspense query re-runs its `queryFn` instead of replaying the
 * cached rejection) AND call `reset`. A regression to `reset`-only is a silent
 * "Retry does nothing" bug CI would otherwise pass.
 *
 * `AccessIndexErrorView` reads `queryClient` + `runAuthed` from router context
 * via `useRouteContext({ from: '__root__', select })`. Rather than mount a
 * whole router, mock `useRouteContext` to feed a real `QueryClient` (so the
 * spied `invalidateQueries` is observable) and a stub `runAuthed` through its
 * `select`.
 */

const runAuthedStub = vi.fn((_effect: unknown) => Promise.resolve(undefined))
const queryClient = new QueryClient()

vi.mock('@tanstack/react-router', () => ({
  // Mirrors `useRouteContext({ from, select })`: the error view's `select`
  // pulls `{ queryClient, runAuthed }` off the context.
  useRouteContext: ({
    select,
  }: {
    select: (context: { queryClient: QueryClient; runAuthed: unknown }) => unknown
  }): unknown => select({ queryClient, runAuthed: runAuthedStub }),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  runAuthedStub.mockClear()
})

describe('AccessIndexErrorView Retry', () => {
  test('invalidates the grants query and clears the boundary on retry', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const reset = vi.fn()

    render(<AccessIndexErrorView error={new Error('boom')} reset={reset} />)

    fireEvent.click(screen.getByText('Retry'))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: GRANTS_QUERY_KEY })
    expect(reset).toHaveBeenCalledTimes(1)
  })
})
