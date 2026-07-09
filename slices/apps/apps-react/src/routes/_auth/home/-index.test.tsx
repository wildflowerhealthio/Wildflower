import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

// `AppsHomeBody` reads its home-screen mutation from `queries.ts` and two
// route-context values; stub both so the tests drive the banner + edit-mode
// behavior purely off the mutation stub and local state.
const { homeScreenStub } = vi.hoisted(() => ({
  homeScreenStub: {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null as Error | null,
  },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    // The body imports `createFileRoute` at module load; stub it so importing the
    // module doesn't pull in the real router.
    createFileRoute: () => (options: unknown) => options,
    // The body reads `apiBaseUrl` + `runAuthed` off the root context.
    useRouteContext: ({ select }: { select: (ctx: unknown) => unknown }) =>
      select({ apiBaseUrl: undefined, runAuthed: vi.fn() }),
  }
})

vi.mock('../../../queries.ts', () => ({
  appsListQueryOptions: vi.fn(),
  useAppsListQuery: vi.fn(),
  useReplaceHomeScreenMutation: () => homeScreenStub,
}))

import type { AppEntry } from '../../../queries.ts'
import { AppsHomeBody } from './index.tsx'

const cloudApp = (overrides: Partial<AppEntry> = {}): AppEntry => ({
  id: 'cloud-app',
  name: 'Cloud App',
  enabled: true,
  provenance: 'cloud',
  localOnly: false,
  smart: false,
  requiresTunnel: false,
  removable: true,
  url: 'https://example.com/launch',
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

    expect(screen.getByRole('button', { name: 'Edit' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull()
  })

  test('tapping "Edit" arms edit mode: the toggle reads "Done" and a "Hide" control appears', () => {
    render(<AppsHomeBody apps={[APP]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Hide' })).toBeDefined()
  })

  test('tapping "Hide" PUTs the whole home screen with that app disabled', () => {
    const other = cloudApp({ id: 'other-app', name: 'Other App' })
    render(<AppsHomeBody apps={[APP, other]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    // Both enabled tiles get a Hide control; the first is the target app.
    const hideButtons = screen.getAllByRole('button', { name: 'Hide' })
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
