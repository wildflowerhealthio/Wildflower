import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Schema } from 'effect'
import { AccessManagement } from 'gatekeeper-core/http-api-definition'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { CLIENTS_QUERY_KEY, GRANTS_QUERY_KEY, type Grant } from '../../../queries/index.ts'
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

/** Answers every call with an empty list — the clients `TrustedAppsSection` loads, unless a test says otherwise. */
const runAuthedStub = vi.fn((_effect: unknown): Promise<unknown> => Promise.resolve([]))
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

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

beforeEach(() => {
  stubDialogModality()
})

afterEach(() => {
  cleanup()
  restoreDialogModality()
  vi.restoreAllMocks()
  queryClient.clear()
  runAuthedStub.mockReset()
  runAuthedStub.mockImplementation(() => Promise.resolve([]))
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
    renderBody([decodeGrant(appGrantBody), decodeGrant(deviceGrantBody)])

    // Both sections render, each with its variant's title field.
    expect(screen.getByText('Approved Apps')).toBeTruthy()
    expect(screen.getByText('client-a')).toBeTruthy()
    expect(screen.getByText('Authorized Devices')).toBeTruthy()
    expect(screen.getByText("Ada's laptop")).toBeTruthy()
  })

  test('omits the Authorized Devices section when there are no device grants', () => {
    renderBody([decodeGrant(appGrantBody)])

    expect(screen.getByText('Approved Apps')).toBeTruthy()
    expect(screen.queryByText('Authorized Devices')).toBeNull()
  })
})

describe('AccessIndexBody trusted apps', () => {
  test('loads the Trusted Apps section beside the grants', async () => {
    runAuthedStub.mockResolvedValueOnce([ohifViewer])

    renderBody([decodeGrant(appGrantBody)])

    expect(screen.getByText('Approved Apps')).toBeTruthy()
    expect(await screen.findByText('OHIF Viewer')).toBeTruthy()
    expect(screen.getByText('Trusted Apps')).toBeTruthy()
  })

  test('keeps the grants when the clients fail to load', async () => {
    runAuthedStub.mockRejectedValueOnce(new Error('Insufficient scope: wildflower/Client.r'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    renderBody([decodeGrant(appGrantBody)])

    expect(await screen.findByText('Error Loading Trusted Apps')).toBeTruthy()
    expect(screen.getByText('Approved Apps')).toBeTruthy()
    expect(screen.getByText('client-a')).toBeTruthy()
  })
})

describe('AccessIndexBody revoke', () => {
  test('holds Revoke while a revoke is in flight, however often it is clicked', async () => {
    const callsBeforeRevoke = await renderBodyWithSettledClients([decodeGrant(appGrantBody)])
    runAuthedStub.mockImplementationOnce(() => new Promise(() => undefined))
    chooseRevoke('client-a')
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' })

    fireEvent.click(confirm)
    await vi.waitFor(() => {
      expect(confirm.hasAttribute('disabled')).toBe(true)
    })
    fireEvent.click(confirm)

    expect(runAuthedStub).toHaveBeenCalledTimes(callsBeforeRevoke + 1)
    fireEvent.click(screen.getByRole('button', { name: 'Actions for client-a' }))
    expect(screen.getByRole('menuitem', { name: 'Revoke' }).hasAttribute('disabled')).toBe(true)
  })

  test('closes the dialog on a failed revoke and surfaces the failure in the banner', async () => {
    await renderBodyWithSettledClients([decodeGrant(appGrantBody)])
    runAuthedStub.mockImplementationOnce(() => Promise.reject(new Error('Gatekeeper unavailable')))
    chooseRevoke('client-a')

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))

    expect((await screen.findAllByText(/Gatekeeper unavailable/)).length).toBeGreaterThan(0)
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(false)
  })
})

// Helpers

const renderBody = (grants: readonly Grant[]): void => {
  render(
    <QueryClientProvider client={queryClient}>
      <AccessIndexBody grants={grants} />
    </QueryClientProvider>
  )
}

/**
 * Render the body with one trusted app, and wait until the Trusted Apps section
 * has rendered and its mount refetch has settled — so the next stubbed call is
 * the test's own. Returns how many calls the section made.
 */
const renderBodyWithSettledClients = async (grants: readonly Grant[]): Promise<number> => {
  runAuthedStub.mockImplementation(() => Promise.resolve([ohifViewer]))
  renderBody(grants)
  await screen.findByText('OHIF Viewer')
  await vi.waitFor(() => {
    expect(queryClient.getQueryState(CLIENTS_QUERY_KEY)?.fetchStatus).toBe('idle')
  })
  return runAuthedStub.mock.calls.length
}

const ohifViewer = Schema.decodeUnknownSync(AccessManagement.ClientSchema)({
  clientId: 'ohif-viewer',
  name: 'OHIF Viewer',
  kind: 'public',
  redirectUris: ['/'],
  allowedScopes: ['openid'],
  allowedGrantTypes: ['authorization_code'],
  registeredAt: '2026-01-15T09:30:00.000Z',
  disabledAt: null,
  firstParty: false,
})

const chooseRevoke = (clientId: string): void => {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${clientId}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke' }))
}

/**
 * jsdom has no native `<dialog>`; model `showModal`/`close` as the `open`
 * attribute (as react-tundraish's own Dialog tests do), and restore the original
 * descriptors afterwards so the patch can't leak into other files.
 */
const dialogMethods = ['showModal', 'close'] as const
const originalDialogDescriptors = dialogMethods.map(
  (key) => [key, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key)] as const
)

const stubDialogModality = (): void => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
}

const restoreDialogModality = (): void => {
  for (const [key, descriptor] of originalDialogDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, key)
    else Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
  }
}
