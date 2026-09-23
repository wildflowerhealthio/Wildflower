import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
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
  // Root-context stub the `useRouteContext` mock reads.
  routeContext: { runAuthed: vi.fn() },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    // The body imports `createFileRoute` at module load; stub it so importing the
    // module doesn't pull in the real router.
    createFileRoute: () => (options: unknown) => options,
    // The body reads `runAuthed` off the root context.
    useRouteContext: ({ select }: { select: (ctx: unknown) => unknown }) => select(routeContext),
    // A tile's launch link: a plain anchor at the route's path, so the tile
    // renders without a router.
    Link: ({
      to,
      params,
      children,
      ...rest
    }: {
      readonly to: string
      readonly params: { readonly id: string }
      readonly children: ReactNode
    }) => (
      <a href={to.replace('$id', params.id)} {...rest}>
        {children}
      </a>
    ),
  }
})

vi.mock('../../../queries.ts', () => ({
  appsListQueryOptions: vi.fn(),
  useAppsListQuery: vi.fn(),
  useReplaceHomeScreenMutation: () => homeScreenStub,
}))

import type { AppRegistration } from '../../../queries.ts'
import { encodeLaunchError } from './-launch-error.ts'
import { AppsHomeBody } from './index.tsx'

const cloudApp = (overrides: Partial<AppRegistration> = {}): AppRegistration => ({
  id: 'cloud-app',
  name: 'Cloud App',
  onHomescreen: true,
  kind: 'cloud',
  localOnly: false,
  isSmart: false,
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

describe('<AppsHomeBody> launch-error banner', () => {
  beforeEach(() => {
    homeScreenStub.isError = false
    homeScreenStub.error = null
  })

  afterEach(() => {
    cleanup()
  })

  test('decodes a launchError body into a friendly banner', () => {
    // A non-scope launch failure reads as a sentence. (A scope failure renders the
    // AuthorizationFailure surface via the app's ambient renderer — covered in the
    // scopes-react / renderer tests; there's no provider here, so use a message body.)
    render(
      <AppsHomeBody apps={[APP]} launchError={encodeLaunchError({ error: 'LaunchUnavailable' })} />
    )

    expect(screen.getByRole('alert').textContent).toContain('reached')
  })

  test('renders no launch banner when there is no launchError', () => {
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
    // Both on-homescreen tiles get a hide badge ("Hide <name>"); the first is the target.
    const hideButtons = screen.getAllByRole('button', { name: /^Hide/ })
    fireEvent.click(hideButtons[0])

    // The single writer of `onHomescreen` is `PUT /home-screen` with the full ordered
    // list — the target flips to `false`, the sibling keeps its slot + flag.
    expect(homeScreenStub.mutate).toHaveBeenCalledTimes(1)
    expect(homeScreenStub.mutate.mock.calls[0]?.[0]).toEqual([
      { id: 'cloud-app', onHomescreen: false },
      { id: 'other-app', onHomescreen: true },
    ])
  })
})

describe('<AppsHomeBody> live content', () => {
  beforeEach(() => {
    homeScreenStub.isError = false
    homeScreenStub.error = null
    homeScreenStub.mutate.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  test('a background refetch that changes only content (same id/onHomescreen) updates the tile', () => {
    // The resync key is id + onHomescreen, so a content-only refetch doesn't
    // re-seed `order` — the bug was that tiles rendered off `order` and so
    // stayed stale. Tile content now reads live from `apps`, so a same-instance
    // rerender with an edited name/subtitle/pill must show through immediately.
    const { rerender } = render(<AppsHomeBody apps={[cloudApp()]} />)
    expect(screen.getByText('Cloud App')).toBeDefined()

    rerender(
      <AppsHomeBody
        apps={[cloudApp({ name: 'Renamed App', subtitle: 'Fresh subtitle', requiresTunnel: true })]}
      />
    )

    // Same id + onHomescreen ⇒ the resync effect stays put, yet the live name,
    // subtitle, and the newly-required Tunnel pill all render.
    expect(screen.queryByText('Cloud App')).toBeNull()
    expect(screen.getByText('Renamed App')).toBeDefined()
    expect(screen.getByText('Fresh subtitle')).toBeDefined()
    expect(screen.getByText('Tunnel')).toBeDefined()
  })

  test('a content-only refetch preserves an optimistic reorder (order stays local, content stays live)', () => {
    // A hide is optimistic on `order`; a content-only refetch must not clobber
    // it. Hide the first tile, then rerender with an edited name for the second:
    // the hidden tile stays gone (optimistic `order` survives) and the surviving
    // tile shows its fresh name (content still comes from `apps`).
    const first = cloudApp({ id: 'first-app', name: 'First App' })
    const second = cloudApp({ id: 'second-app', name: 'Second App' })
    const { rerender } = render(<AppsHomeBody apps={[first, second]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit home screen' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide First App' }))

    rerender(
      <AppsHomeBody apps={[first, cloudApp({ id: 'second-app', name: 'Second Renamed' })]} />
    )

    const list = screen.getByRole('list')
    expect(within(list).queryByText('First App')).toBeNull()
    expect(within(list).getByText('Second Renamed')).toBeDefined()
  })
})

describe('<AppsHomeBody> launch tiles', () => {
  beforeEach(() => {
    // The host opened the app (a loopback `204`): `LaunchApp` resolves empty.
    routeContext.runAuthed.mockReset()
    routeContext.runAuthed.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  test('each view-mode tile is a link to its app’s launch route', () => {
    render(<AppsHomeBody apps={[APP]} />)

    // A real link, so hover shows it and right-click → "Open in new tab" works.
    const link = screen.getByRole('link', { name: /Cloud App/ })
    expect(link.getAttribute('href')).toBe('/home/launch/cloud-app')
  })

  test('a plain click launches here, through this page’s session', () => {
    const open = vi.spyOn(window, 'open')
    render(<AppsHomeBody apps={[APP]} />)

    const followed = fireEvent.click(screen.getByRole('link', { name: /Cloud App/ }))

    expect(followed).toBe(false)
    expect(routeContext.runAuthed).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })

  test('a cmd/ctrl click opens a tab inside the click, then launches into it', async () => {
    // Arrange — the tab the page opens; the host opens this app natively, so
    // the tab has nothing to show and closes again.
    const tab = { close: vi.fn(), opener: null, location: { replace: vi.fn() } }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in for the opened Window
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    render(<AppsHomeBody apps={[APP]} />)

    // Act
    const followed = fireEvent.click(screen.getByRole('link', { name: /Cloud App/ }), {
      ctrlKey: true,
    })

    // Assert — opened synchronously (popup blockers allow it only there), the
    // launch still rides this page's bearer, and the empty tab closes.
    expect(followed).toBe(false)
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(routeContext.runAuthed).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(tab.close).toHaveBeenCalled()
    })
  })

  test('a right click is left to the browser', () => {
    render(<AppsHomeBody apps={[APP]} />)

    const followed = fireEvent(
      screen.getByRole('link', { name: /Cloud App/ }),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 })
    )

    expect(followed).toBe(true)
    expect(routeContext.runAuthed).not.toHaveBeenCalled()
  })
})
