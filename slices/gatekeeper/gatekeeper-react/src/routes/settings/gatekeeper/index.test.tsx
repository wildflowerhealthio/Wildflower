import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Schema } from 'effect'
import { AccessManagement } from 'gatekeeper-core/http-api-definition'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { GRANTS_QUERY_KEY } from '../../../queries/index.ts'
import { AccessIndexBody, AccessIndexErrorView } from './index.tsx'

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

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    // The route module calls `createFileRoute('/settings/gatekeeper/')({...})` at
    // import time, so the stub must accept the path and return the config passthrough.
    createFileRoute:
      () =>
      (config: unknown): unknown =>
        config,
    useNavigate: () => (): void => undefined,
    // Mirrors `useRouteContext({ from, select })`: the error view's `select`
    // pulls `{ queryClient, runAuthed }` off the context.
    useRouteContext: ({
      select,
    }: {
      select: (context: { queryClient: QueryClient; runAuthed: unknown }) => unknown
    }): unknown => select({ queryClient, runAuthed: runAuthedStub }),
    // `AccessIndexBody`'s `PageHeader` back-link renders a TanStack `<Link>`;
    // stub it to a plain anchor so the body renders without a `RouterProvider`.
    Link: ({ to, children }: { to?: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  }
})

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

/**
 * The access index renders the grant union as two sections: code-flow grants
 * under "Approved Apps" (titled by clientId) and device-flow grants under
 * "Authorized Devices" (titled by deviceName). Fixtures are decoded through the
 * real `GrantSchema` so the split keys off the same wire shape the server emits.
 */
const decodeGrant = Schema.decodeUnknownSync(AccessManagement.GrantSchema)

const appGrantBody = {
  id: 'g-app',
  clientId: 'client-a',
  scopes: ['read'],
  grantType: 'authorization_code',
  redirectUri: 'https://example.com/cb',
  grantedAt: '2024-01-01T00:00:00.000Z',
  lastUsedAt: null,
  patient: null,
}

const deviceGrantBody = {
  id: 'g-dev',
  clientId: 'client-b',
  scopes: ['openid', 'offline_access'],
  grantType: 'device_code',
  deviceName: "Ada's laptop",
  grantedAt: '2024-02-02T00:00:00.000Z',
  lastUsedAt: null,
  patient: null,
}

describe('AccessIndexBody grant splitting', () => {
  test('renders code grants as Approved Apps and device grants as Authorized Devices', () => {
    const grants = [decodeGrant(appGrantBody), decodeGrant(deviceGrantBody)]

    render(
      <QueryClientProvider client={queryClient}>
        <AccessIndexBody grants={grants} />
      </QueryClientProvider>
    )

    // Both sections render, each with its variant's title field.
    expect(screen.getByText('Approved Apps')).toBeTruthy()
    expect(screen.getByText('client-a')).toBeTruthy()
    expect(screen.getByText('Authorized Devices')).toBeTruthy()
    expect(screen.getByText("Ada's laptop")).toBeTruthy()
  })

  test('omits the Authorized Devices section when there are no device grants', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AccessIndexBody grants={[decodeGrant(appGrantBody)]} />
      </QueryClientProvider>
    )

    expect(screen.getByText('Approved Apps')).toBeTruthy()
    expect(screen.queryByText('Authorized Devices')).toBeNull()
  })
})
