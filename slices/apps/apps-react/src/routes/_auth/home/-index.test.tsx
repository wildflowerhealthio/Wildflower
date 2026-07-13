import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

// `AppsHomeBody` reads its home-screen mutation from `queries.ts` and two
// route-context values; stub both so the tests drive the banner + edit-mode
// behavior purely off the mutation stub and local state.
const { homeScreenStub, routeContext } = vi.hoisted(() => ({
  homeScreenStub: {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null as Error | null,
  },
  // Mutable root-context stub the `useRouteContext` mock reads. `apiBaseUrl`
  // undefined = the web arm (tiles are anchors); set = the Tauri arm (buttons).
  // Tests flip it per case; `beforeEach` resets it to web.
  routeContext: { apiBaseUrl: undefined as string | undefined, runAuthed: vi.fn() },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    // The body imports `createFileRoute` at module load; stub it so importing the
    // module doesn't pull in the real router.
    createFileRoute: () => (options: unknown) => options,
    // The body reads `apiBaseUrl` + `runAuthed` off the root context.
    useRouteContext: ({ select }: { select: (ctx: unknown) => unknown }) => select(routeContext),
  }
})

vi.mock('../../../queries.ts', () => ({
  appsListQueryOptions: vi.fn(),
  useAppsListQuery: vi.fn(),
  useReplaceHomeScreenMutation: () => homeScreenStub,
}))

import type { AppRegistration } from '../../../queries.ts'
import { AppsHomeBody } from './index.tsx'

const cloudApp = (overrides: Partial<AppRegistration> = {}): AppRegistration => ({
  id: 'cloud-app',
  name: 'Cloud App',
  enabled: true,
  kind: 'cloud',
  localOnly: false,
  smart: false,
  requiresTunnel: false,
  ...overrides,
})

const APP = cloudApp()

describe('<AppsHomeBody> reorder-failure banner', () => {
  beforeEach(() => {
    homeScreenStub.isError = false
    homeScreenStub.error = null
    homeScreenStub.mutate.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  test('surfaces a banner with the error message when a home-screen PUT failed', () => {
    homeScreenStub.isError = true
    homeScreenStub.error = new Error('home-screen save failed')

    render(<AppsHomeBody apps={[APP]} />)

    // The banner is the only alert; it carries the formatted mutation error so a
    // silent UI/server divergence is visible.
    expect(screen.getByRole('alert').textContent).toContain('home-screen save failed')
  })

  test('renders no banner while the home-screen mutation is idle', () => {
    render(<AppsHomeBody apps={[APP]} />)

    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('<AppsHomeBody> edit mode', () => {
  beforeEach(() => {
    homeScreenStub.isError = false
    homeScreenStub.error = null
    homeScreenStub.mutate.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  test('defaults to view mode: an "Edit" toggle and no "Hide" controls', () => {
    render(<AppsHomeBody apps={[APP]} />)

    expect(screen.getByRole('button', { name: 'Edit home screen' })).toBeDefined()
    // The per-tile hide badge is labelled "Hide <app name>".
    expect(screen.queryByRole('button', { name: /^Hide/ })).toBeNull()
  })

  test('tapping "Edit" arms edit mode: the toggle reads "Done" and a "Hide" control appears', () => {
    render(<AppsHomeBody apps={[APP]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit home screen' }))

    expect(screen.getByRole('button', { name: 'Done editing' })).toBeDefined()
    expect(screen.getByRole('button', { name: /^Hide/ })).toBeDefined()
  })

  test('tapping "Hide" PUTs the whole home screen with that app disabled', () => {
    const other = cloudApp({ id: 'other-app', name: 'Other App' })
    render(<AppsHomeBody apps={[APP, other]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit home screen' }))
    // Both enabled tiles get a hide badge ("Hide <name>"); the first is the target.
    const hideButtons = screen.getAllByRole('button', { name: /^Hide/ })
    fireEvent.click(hideButtons[0])

    // The single writer of `enabled` is `PUT /home-screen` with the full ordered
    // list — the target flips to `false`, the sibling keeps its slot + flag.
    expect(homeScreenStub.mutate).toHaveBeenCalledTimes(1)
    expect(homeScreenStub.mutate.mock.calls[0]?.[0]).toEqual([
      { id: 'cloud-app', enabled: false },
      { id: 'other-app', enabled: true },
    ])
  })
})

describe('<AppsHomeBody> launch tiles', () => {
  beforeEach(() => {
    homeScreenStub.isError = false
    homeScreenStub.error = null
    homeScreenStub.mutate.mockClear()
    // Default each case to the web arm; the Tauri test opts in explicitly.
    routeContext.apiBaseUrl = undefined
  })

  afterEach(() => {
    cleanup()
    routeContext.apiBaseUrl = undefined
  })

  test('web arm: each view-mode tile is an <a href="/apps/{id}"> the browser follows', () => {
    render(<AppsHomeBody apps={[APP]} />)

    // A real anchor to the page-relative launch route — a plain click navigates
    // this tab, a cmd/ctrl-click opens a new one, and the auth cookie rides the
    // request. `rel` keeps crawlers off the launch route and withholds referrer.
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('/apps/cloud-app')
    expect(link.getAttribute('rel')).toBe('nofollow noreferrer')
  })

  test('Tauri arm (apiBaseUrl set): the tile is a non-navigating button, not an anchor', () => {
    routeContext.apiBaseUrl = 'http://127.0.0.1:8080'

    render(<AppsHomeBody apps={[APP]} />)

    // No anchor — the loopback arm launches through the authed client and the
    // webview must never navigate. The tile still renders (its name is present),
    // it's just a button rather than a link.
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Cloud App')).toBeDefined()
  })
})
