import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

// The per-kind route files call `createFileRoute(...)` at import and render a
// TanStack `<Link>` in the shared header; stub both so the screens render without
// a `RouterProvider`. `Link` becomes a plain anchor.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createFileRoute: () => (config: unknown) => config,
    useNavigate: () => (): void => undefined,
    Link: ({ to, children }: { to?: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  }
})

// The shell + its embedded forms + the per-kind detail queries all come from
// `queries.ts`; stub them so the tests assert the exact payloads each control
// PUTs. `detailData` / `listData` are set per test.
const { homeScreenStub, deleteStub, cloudReplaceStub, selfHostedReplaceStub, mocks } = vi.hoisted(
  () => {
    const mockState: { detail: unknown; list: readonly unknown[] } = { detail: undefined, list: [] }
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
      cloudReplaceStub: {
        mutate: vi.fn(),
        reset: vi.fn(),
        isPending: false,
        error: null as Error | null,
      },
      selfHostedReplaceStub: {
        mutate: vi.fn(),
        reset: vi.fn(),
        isPending: false,
        error: null as Error | null,
      },
      mocks: mockState,
    }
  }
)

vi.mock('../../../queries.ts', () => ({
  useReplaceHomeScreenMutation: () => homeScreenStub,
  useAppsAdminDeleteMutation: () => deleteStub,
  useCloudAppReplaceMutation: () => cloudReplaceStub,
  useSelfHostedAppReplaceMutation: () => selfHostedReplaceStub,
  useAppsListQuery: () => ({ data: mocks.list }),
  useCloudAppQuery: () => ({ data: mocks.detail }),
  useSelfHostedAppQuery: () => ({ data: mocks.detail }),
  useSystemAppQuery: () => ({ data: mocks.detail }),
  cloudAppQueryOptions: vi.fn(),
  selfHostedAppQueryOptions: vi.fn(),
  systemAppQueryOptions: vi.fn(),
}))

import { CloudAppDetailScreen } from './cloud/$id.tsx'
import { SelfHostedAppDetailScreen } from './self-hosted/$id.tsx'
import { SystemAppDetailScreen } from './system/$id.tsx'

const CLOUD_DETAIL = {
  id: 'cloud-app',
  name: 'Cloud App',
  kind: 'cloud',
  onHomescreen: true,
  localOnly: false,
  isSmart: false,
  requiresTunnel: false,
  url: 'https://example.com/launch',
  isRemovable: true,
}

const SELF_HOSTED_UPLOADED = {
  id: 'sh-app',
  name: 'Self Hosted App',
  kind: 'self-hosted',
  onHomescreen: true,
  localOnly: false,
  isSmart: false,
  requiresTunnel: false,
  launchPath: '/launch.html',
  seeded: false,
  isRemovable: true,
}

const SELF_HOSTED_SEEDED = {
  ...SELF_HOSTED_UPLOADED,
  id: 'seeded-app',
  name: 'Seeded App',
  seeded: true,
  isRemovable: false,
  launchPath: undefined,
}

const SYSTEM_DETAIL = {
  id: 'sys-app',
  name: 'System App',
  kind: 'system',
  onHomescreen: true,
  localOnly: false,
  isSmart: false,
  requiresTunnel: false,
  url: '{origin}/docs',
}

/** A uniform list entry (registration) for the shell's home-screen toggle. */
const listEntry = (detail: {
  id: string
  name: string
  kind: string
}): Record<string, unknown> => ({
  id: detail.id,
  name: detail.name,
  kind: detail.kind,
  onHomescreen: true,
  localOnly: false,
  isSmart: false,
  requiresTunnel: false,
})

describe('per-kind app detail screens', () => {
  beforeEach(() => {
    homeScreenStub.mutate.mockClear()
    deleteStub.mutate.mockClear()
    cloudReplaceStub.mutate.mockClear()
    selfHostedReplaceStub.mutate.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  test('the enable switch PUTs the whole home screen with this app flipped', () => {
    mocks.detail = CLOUD_DETAIL
    mocks.list = [listEntry(CLOUD_DETAIL)]
    render(<CloudAppDetailScreen id="cloud-app" />)

    fireEvent.click(screen.getByRole('switch', { name: 'Show on home screen' }))

    expect(homeScreenStub.mutate).toHaveBeenCalledTimes(1)
    expect(homeScreenStub.mutate.mock.calls[0]?.[0]).toEqual([
      { id: 'cloud-app', onHomescreen: false },
    ])
  })

  test('a cloud app saves its content through the cloud replace arm', () => {
    mocks.detail = CLOUD_DETAIL
    mocks.list = [listEntry(CLOUD_DETAIL)]
    render(<CloudAppDetailScreen id="cloud-app" />)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(cloudReplaceStub.mutate).toHaveBeenCalledTimes(1)
    expect(cloudReplaceStub.mutate.mock.calls[0]?.[0]).toEqual({
      id: 'cloud-app',
      payload: {
        name: 'Cloud App',
        url: 'https://example.com/launch',
        requiresTunnel: false,
      },
    })
  })

  test('an uploaded self-hosted app saves its launch path through the self-hosted replace arm', () => {
    mocks.detail = SELF_HOSTED_UPLOADED
    mocks.list = [listEntry(SELF_HOSTED_UPLOADED)]
    render(<SelfHostedAppDetailScreen id="sh-app" />)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(selfHostedReplaceStub.mutate).toHaveBeenCalledTimes(1)
    expect(selfHostedReplaceStub.mutate.mock.calls[0]?.[0]).toEqual({
      id: 'sh-app',
      launchPath: '/launch.html',
    })
  })

  test('an isRemovable app can be deleted by id', () => {
    mocks.detail = CLOUD_DETAIL
    mocks.list = [listEntry(CLOUD_DETAIL)]
    render(<CloudAppDetailScreen id="cloud-app" />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete from my device' }))

    expect(deleteStub.mutate).toHaveBeenCalledTimes(1)
    expect(deleteStub.mutate.mock.calls[0]?.[0]).toEqual({ id: 'cloud-app' })
  })

  test('a system app shows a read-only note, no edit form, and no delete', () => {
    mocks.detail = SYSTEM_DETAIL
    mocks.list = [listEntry(SYSTEM_DETAIL)]
    render(<SystemAppDetailScreen id="sys-app" />)

    // Enable/disable still applies to every kind.
    expect(screen.getByRole('switch', { name: 'Show on home screen' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete from my device' })).toBeNull()
    expect(screen.getByText(/settings aren't editable/i)).toBeDefined()
  })

  test('a seeded self-hosted app shows a read-only note, no edit form, and no delete', () => {
    mocks.detail = SELF_HOSTED_SEEDED
    mocks.list = [listEntry(SELF_HOSTED_SEEDED)]
    render(<SelfHostedAppDetailScreen id="seeded-app" />)

    expect(screen.getByRole('switch', { name: 'Show on home screen' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete from my device' })).toBeNull()
    expect(screen.getByText(/settings aren't editable/i)).toBeDefined()
  })
})
