import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

// `AppsHomeBody` reads its reorder mutation from `queries.ts` and two route-context
// values; stub both so the test drives the banner purely off the mutation's
// `isError`/`error` — the way a failed `PUT /home-screen` leaves it.
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

// `AppsEditor` (rendered closed by the body) folds `useIsMutating` into its busy
// state; pin it to 0 so it doesn't need a live QueryClient.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useIsMutating: () => 0 }
})

vi.mock('../../../queries.ts', () => {
  const idleMutation = (): unknown => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  })
  return {
    HOME_SCREEN_MUTATION_KEY: ['apps', 'home-screen'],
    appsListQueryOptions: vi.fn(),
    useAppsListQuery: vi.fn(),
    useReplaceHomeScreenMutation: () => homeScreenStub,
    useAppsAdminCreateMutation: idleMutation,
    useAppsAdminDeleteMutation: idleMutation,
  }
})

import type { AppEntry } from '../../../queries.ts'
import { AppsHomeBody } from './index.tsx'

const APP: AppEntry = {
  id: 'cloud-app',
  name: 'Cloud App',
  enabled: true,
  provenance: 'cloud',
  localOnly: false,
  smart: false,
  requiresTunnel: false,
}

// react-tundraish's `Dialog` (mounted closed by the editor) calls native
// <dialog> methods jsdom lacks; stub them as the editor's own test does.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')

describe('<AppsHomeBody> reorder-failure banner', () => {
  beforeEach(() => {
    homeScreenStub.isError = false
    homeScreenStub.error = null
    homeScreenStub.mutate.mockClear()
    HTMLDialogElement.prototype.showModal = function showModal(): void {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function close(): void {
      this.removeAttribute('open')
    }
  })

  afterEach(() => {
    cleanup()
    if (originalShowModal === undefined) {
      Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
    } else {
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
    }
    if (originalClose === undefined) {
      Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
    } else {
      Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
    }
  })

  test('surfaces a banner with the error message when the reorder PUT failed', () => {
    homeScreenStub.isError = true
    homeScreenStub.error = new Error('home-screen save failed')

    render(<AppsHomeBody apps={[APP]} />)

    // The banner is the only alert; it carries the formatted mutation error so a
    // silent UI/server divergence is visible.
    expect(screen.getByRole('alert').textContent).toContain('home-screen save failed')
  })

  test('renders no banner while the reorder mutation is idle', () => {
    render(<AppsHomeBody apps={[APP]} />)

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
