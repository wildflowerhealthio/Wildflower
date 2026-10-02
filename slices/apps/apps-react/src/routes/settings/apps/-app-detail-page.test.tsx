import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

// The route file calls `createFileRoute(...)` at import and renders a TanStack
// `<Link>` in the header; stub both so the screen renders without a
// `RouterProvider`. `Link` becomes a plain anchor.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createFileRoute: () => (config: unknown) => config,
    useNavigate: () => (): void => undefined,
    Link: ({ to, children }: { to?: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  }
})

// The page + its edit form + the by-id read all come from `queries.ts`; stub them
// so the tests assert the exact payloads each control sends. `mocks.app` /
// `mocks.list` are set per test.
const { homeScreenStub, deleteStub, replaceStub, mocks } = vi.hoisted(() => {
  const mockState: { app: unknown; list: readonly unknown[] } = { app: undefined, list: [] }
  return {
    homeScreenStub: {
      mutate: vi.fn(),
      reset: vi.fn(),
      isPending: false,
      error: null as Error | null,
    },
    deleteStub: {
      mutate: vi.fn(),
      reset: vi.fn(),
      isPending: false,
      error: null as Error | null,
    },
    replaceStub: {
      mutate: vi.fn(),
      reset: vi.fn(),
      isPending: false,
      error: null as Error | null,
    },
    mocks: mockState,
  }
})

vi.mock('../../../queries.ts', () => ({
  useReplaceHomeScreenMutation: () => homeScreenStub,
  useAppDeleteMutation: () => deleteStub,
  useAppReplaceMutation: () => replaceStub,
  useAppsListQuery: () => ({ data: mocks.list }),
  useAppQuery: () => ({ data: mocks.app }),
  appQueryOptions: vi.fn(),
}))

import { AppDetailScreen } from './$id.tsx'

const APP = {
  id: 'my-app',
  name: 'My App',
  onHomescreen: true,
  url: 'https://example.com/launch',
  isSmart: false,
  requiresTunnel: false,
}

describe('app detail screen', () => {
  beforeEach(() => {
    homeScreenStub.mutate.mockClear()
    deleteStub.mutate.mockClear()
    replaceStub.mutate.mockClear()
    mocks.app = APP
    mocks.list = [APP]
  })

  afterEach(() => {
    cleanup()
  })

  test('the enable switch PUTs the whole home screen with this app flipped', () => {
    render(<AppDetailScreen id="my-app" />)

    fireEvent.click(screen.getByRole('switch', { name: 'Show on home screen' }))

    expect(homeScreenStub.mutate).toHaveBeenCalledTimes(1)
    expect(homeScreenStub.mutate.mock.calls[0]?.[0]).toEqual([
      { id: 'my-app', onHomescreen: false },
    ])
  })

  test('saving PUTs the edited content to the app', () => {
    render(<AppDetailScreen id="my-app" />)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(replaceStub.mutate).toHaveBeenCalledTimes(1)
    expect(replaceStub.mutate.mock.calls[0]?.[0]).toEqual({
      id: 'my-app',
      payload: {
        name: 'My App',
        url: 'https://example.com/launch',
        requiresTunnel: false,
      },
    })
  })

  test('the app can be deleted by id', () => {
    render(<AppDetailScreen id="my-app" />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete from my device' }))

    expect(deleteStub.mutate).toHaveBeenCalledTimes(1)
    expect(deleteStub.mutate.mock.calls[0]?.[0]).toEqual({ id: 'my-app' })
  })
})
