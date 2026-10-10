import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { type JSX, type ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  useCreateRemoteMutation,
  useDeleteRemoteMutation,
  useUpdateRemoteMutation,
} from './remotes.ts'

/**
 * Pins each collector mutation's `onSuccess` invalidation keys — the
 * whole point of the TanStack migration is that refetches ride
 * `invalidateQueries` rather than the old manual `refresh()`, so a wrong
 * key (e.g. invalidating the wrong root, or a dead self-invalidate that a
 * navigated-away screen never re-reads) is a silent regression CI would
 * otherwise pass.
 *
 * The mutations read `runAuthed` from router context via
 * `useRouteContext({ from: '__root__' })`. Rather than mount a whole
 * router, mock `useRouteContext` to feed the stub runner through its
 * `select`, and provide a real `QueryClientProvider` so `useQueryClient`
 * and `useMutation` resolve. The transport is stubbed: `runAuthed`
 * resolves immediately so `onSuccess` fires and we can read the spied
 * `invalidateQueries` calls.
 */

const runAuthedStub = vi.fn((_effect: unknown) => Promise.resolve(undefined))

vi.mock('@tanstack/react-router', () => ({
  // Mirrors `useRouteContext({ from, select })`: the slice's
  // `useRunAuthed` passes a `select` that pulls `context.runAuthed`.
  useRouteContext: ({
    select,
  }: {
    select: (context: { runAuthed: unknown }) => unknown
  }): unknown => select({ runAuthed: runAuthedStub }),
}))

const renderWithClient = <THook,>(
  useHook: () => THook
): { result: { current: THook }; queryClient: QueryClient } => {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(useHook, { wrapper })
  return { result, queryClient }
}

afterEach(() => {
  runAuthedStub.mockClear()
})

const CONFIG = { _tag: 'fhir-r4', rootUrl: 'https://example.test/fhir', patientId: 'p-1' } as const

describe('useCreateRemoteMutation invalidation', () => {
  test('invalidates the remotes list root (the surface the user lands on)', async () => {
    const { result, queryClient } = renderWithClient(() => useCreateRemoteMutation())
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await result.current.mutateAsync({ id: 'remote-1', name: 'Demo', config: CONFIG })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['collector', 'remotes'] })
    })
    // A create has no prior detail to invalidate — assert it doesn't fire one.
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['collector', 'remote', 'remote-1'],
    })
  })
})

describe('useUpdateRemoteMutation invalidation', () => {
  test('invalidates the remotes list root and the edited remote detail', async () => {
    const { result, queryClient } = renderWithClient(() => useUpdateRemoteMutation())
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await result.current.mutateAsync({ id: 'remote-1', payload: { name: 'Demo', config: CONFIG } })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['collector', 'remotes'] })
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['collector', 'remote', 'remote-1'] })
  })
})

describe('useDeleteRemoteMutation invalidation', () => {
  test('invalidates the remotes list root and the deleted remote detail', async () => {
    const { result, queryClient } = renderWithClient(() => useDeleteRemoteMutation())
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await result.current.mutateAsync({ id: 'remote-2' })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['collector', 'remotes'] })
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['collector', 'remote', 'remote-2'] })
  })
})
