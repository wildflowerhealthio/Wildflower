import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

// `$id.tsx` calls `createFileRoute(...)` at import and its `PageHeader` back link
// renders a TanStack `<Link>`; stub both so the body renders without a
// `RouterProvider`. `Link` becomes a plain anchor (PageHeader forwards the rest).
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createFileRoute: () => (config: unknown) => config,
    useNavigate: () => (): void => undefined,
    Link: ({ to, children }: { to?: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  }
})

// The detail body + its embedded forms read four mutations from `queries.ts`;
// stub them so the tests assert the exact payloads each control PUTs.
const { homeScreenStub, deleteStub, replaceStub } = vi.hoisted(() => ({
  homeScreenStub: {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null as Error | null,
  },
  deleteStub: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as Error | null },
  replaceStub: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as Error | null },
}))

vi.mock('../../../queries.ts', () => ({
  useReplaceHomeScreenMutation: () => homeScreenStub,
  useAppsAdminDeleteMutation: () => deleteStub,
  useAppsAdminReplaceMutation: () => replaceStub,
  // Imported by `$id.tsx` for the route Screen (not exercised here).
  appsListQueryOptions: vi.fn(),
  useAppsListQuery: vi.fn(),
}))

import type { AppEntry } from '../../../queries.ts'
import { AppDetailBody } from './$id.tsx'

const CLOUD: AppEntry = {
  id: 'cloud-app',
  name: 'Cloud App',
  enabled: true,
  provenance: 'cloud',
  localOnly: false,
  smart: false,
  requiresTunnel: false,
  removable: true,
  url: 'https://example.com/launch',
}

const SELF_HOSTED: AppEntry = {
  id: 'sh-app',
  name: 'Self Hosted App',
  enabled: true,
  provenance: 'self-hosted',
  localOnly: false,
  smart: false,
  removable: true,
  launchPath: '/launch.html',
}

const SYSTEM: AppEntry = {
  id: 'sys-app',
  name: 'System App',
  enabled: true,
  provenance: 'system',
  localOnly: false,
  smart: false,
  removable: false,
}

const noop = (): void => {}

describe('<AppDetailBody>', () => {
  beforeEach(() => {
    homeScreenStub.mutate.mockClear()
    deleteStub.mutate.mockClear()
    replaceStub.mutate.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  test('the enable switch PUTs the whole home screen with this app flipped', () => {
    render(<AppDetailBody app={CLOUD} apps={[CLOUD]} onRemoved={noop} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Show on home screen' }))

    expect(homeScreenStub.mutate).toHaveBeenCalledTimes(1)
    expect(homeScreenStub.mutate.mock.calls[0]?.[0]).toEqual([{ id: 'cloud-app', enabled: false }])
  })

  test('a cloud app saves its content through the cloud replace arm', () => {
    render(<AppDetailBody app={CLOUD} apps={[CLOUD]} onRemoved={noop} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(replaceStub.mutate).toHaveBeenCalledTimes(1)
    expect(replaceStub.mutate.mock.calls[0]?.[0]).toEqual({
      id: 'cloud-app',
      payload: {
        provenance: 'cloud',
        name: 'Cloud App',
        url: 'https://example.com/launch',
        requiresTunnel: false,
      },
    })
  })

  test('an uploaded self-hosted app saves its launch path through the self-hosted replace arm', () => {
    render(<AppDetailBody app={SELF_HOSTED} apps={[SELF_HOSTED]} onRemoved={noop} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save launch path' }))

    expect(replaceStub.mutate).toHaveBeenCalledTimes(1)
    expect(replaceStub.mutate.mock.calls[0]?.[0]).toEqual({
      id: 'sh-app',
      payload: { provenance: 'self-hosted', launchPath: '/launch.html' },
    })
  })

  test('a removable app can be removed by id', () => {
    render(<AppDetailBody app={CLOUD} apps={[CLOUD]} onRemoved={noop} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove app' }))

    expect(deleteStub.mutate).toHaveBeenCalledTimes(1)
    expect(deleteStub.mutate.mock.calls[0]?.[0]).toEqual({ id: 'cloud-app' })
  })

  test('a system app shows a read-only tag, no edit form, and no Remove', () => {
    render(<AppDetailBody app={SYSTEM} apps={[SYSTEM]} onRemoved={noop} />)

    // Enable/disable still applies to every provenance.
    expect(screen.getByRole('switch', { name: 'Show on home screen' })).toBeDefined()
    // But the content is not editable and can't be removed.
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save launch path' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove app' })).toBeNull()
    expect(screen.getByText(/settings aren't editable/i)).toBeDefined()
  })
})
