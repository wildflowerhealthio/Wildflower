import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

// `AppsEditor` reads its three mutations from `queries.ts`. The reset
// bug under test is purely about the editor's reaction to the `open`
// prop transition — not the mutations' transport — so stub the three
// hooks with controllable mutation objects. Each stub exposes a spy
// `reset` (so we can assert it fires on open) and a settable `error` (so
// we can plant a stale error the way a failed write would leave one
// behind while `Dialog` keeps the children mounted).
const { homeScreenStub, createStub, deleteStub, isMutatingRef } = vi.hoisted(() => {
  const makeMutation = (): {
    readonly mutate: ReturnType<typeof vi.fn>
    readonly reset: ReturnType<typeof vi.fn>
    isPending: boolean
    error: Error | null
  } => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  })
  return {
    homeScreenStub: makeMutation(),
    createStub: makeMutation(),
    deleteStub: makeMutation(),
    // Controls the mocked `useIsMutating` return — the count of in-flight
    // home-screen PUTs the editor sees (its own + the home screen's drag).
    isMutatingRef: { count: 0 },
  }
})

vi.mock('../queries.ts', () => ({
  HOME_SCREEN_MUTATION_KEY: ['apps', 'home-screen'],
  useReplaceHomeScreenMutation: () => homeScreenStub,
  useAppsAdminCreateMutation: () => createStub,
  useAppsAdminDeleteMutation: () => deleteStub,
}))

// `busy` folds in `useIsMutating` for the shared home-screen key (so a toggle is
// disabled while the home screen's drag PUT is still landing). Mock it to a
// controllable in-flight count so the disabled-while-in-flight behaviour is
// deterministic without a live QueryClient.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useIsMutating: () => isMutatingRef.count }
})

import type { AppEntry } from '../queries.ts'
import { AppsEditor } from './apps-editor.tsx'

// Helpers
const NO_APPS: readonly AppEntry[] = []

// A row of each provenance. Every row gets an enable-toggle; `provenance` drives
// only whether `Remove` (cloud) or a read-only provenance tag (non-cloud) renders
// beside it. The other flags are the lightest valid wire shape; the editor reads
// only `id`, `name`, `subtitle`, `enabled`, `provenance`.
const makeApp = (overrides: Partial<AppEntry> & Pick<AppEntry, 'id' | 'provenance'>): AppEntry => ({
  name: overrides.id,
  enabled: true,
  localOnly: false,
  smart: false,
  requiresTunnel: false,
  ...overrides,
})

const renderEditor = (open: boolean): ReturnType<typeof render> =>
  render(<AppsEditor open={open} apps={NO_APPS} onClose={() => {}} />)

// The "Add app" form always renders a labelled "Requires tunnel" checkbox; a
// per-row enable toggle is an *unlabelled* checkbox on top of it. Filter the
// form's checkbox out so a row-control assertion isn't fooled by it.
const rowToggles = (): readonly HTMLElement[] => {
  const requiresTunnel = screen.queryByRole('checkbox', { name: 'Requires tunnel' })
  return screen.getAllByRole('checkbox').filter((checkbox) => checkbox !== requiresTunnel)
}

const resetAllStubs = (): void => {
  for (const stub of [homeScreenStub, createStub, deleteStub]) {
    stub.mutate.mockClear()
    stub.reset.mockClear()
    stub.isPending = false
    stub.error = null
  }
  isMutatingRef.count = 0
}

// jsdom does not implement the native <dialog> methods react-tundraish's
// `Dialog` calls in a layout effect. Stub them (mirroring
// react-tundraish's own `dialog.test.tsx`) so the editor mounts, and
// restore the originals after so the patch doesn't leak across files.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')

const restoreOrDelete = (
  key: 'showModal' | 'close',
  descriptor: PropertyDescriptor | undefined
): void => {
  if (descriptor === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, key)
  } else {
    Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
  }
}

describe('<AppsEditor> mutation reset on open', () => {
  beforeEach(() => {
    resetAllStubs()
    HTMLDialogElement.prototype.showModal = function showModal(): void {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function close(): void {
      this.removeAttribute('open')
    }
  })

  afterEach(() => {
    cleanup()
    restoreOrDelete('showModal', originalShowModal)
    restoreOrDelete('close', originalClose)
  })

  test('shows a settled mutation error while open', () => {
    // Arrange — a previous write failed; its error persists on the stub.
    homeScreenStub.error = new Error('toggle failed')

    // Act
    renderEditor(true)

    // Assert — the editor surfaces the stale error in its alert region.
    expect(screen.getByRole('alert').textContent).toBe('toggle failed')
  })

  test('resets all three mutations when the dialog transitions to open', () => {
    // Arrange — start closed so the open-transition effect has not run.
    const { rerender } = renderEditor(false)
    expect(homeScreenStub.reset).not.toHaveBeenCalled()

    // Act — open the dialog.
    rerender(<AppsEditor open apps={NO_APPS} onClose={() => {}} />)

    // Assert — every mutation is reset on the open transition, so no
    // stale error from a prior session can leak into the fresh open.
    expect(homeScreenStub.reset).toHaveBeenCalledTimes(1)
    expect(createStub.reset).toHaveBeenCalledTimes(1)
    expect(deleteStub.reset).toHaveBeenCalledTimes(1)
  })

  test('surfaces the alert from the live mutation error, not a stale snapshot', () => {
    // Arrange — open with a write error present on the mutation.
    homeScreenStub.error = new Error('write failed')
    const { rerender } = renderEditor(true)
    expect(screen.getByRole('alert').textContent).toBe('write failed')

    // Act — react-query's `reset()` clears `mutation.error` and re-renders
    // subscribers. Drive that from the source the component reads: flip the
    // live mutation `error` to null and rerender.
    homeScreenStub.error = null
    rerender(<AppsEditor open apps={NO_APPS} onClose={() => {}} />)

    // Assert — the alert follows the live mutation error to null, proving
    // the editor renders the alert off `homeScreenMutation.error` rather than a
    // value the test plants independently of the component.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('does not re-reset on re-renders while already open', () => {
    // Arrange — open once (one reset), then re-render still open.
    const { rerender } = renderEditor(true)
    expect(homeScreenStub.reset).toHaveBeenCalledTimes(1)

    // Act — a no-op prop change that keeps `open` true.
    rerender(<AppsEditor open apps={NO_APPS} onClose={() => {}} />)

    // Assert — the effect is keyed on the `open` transition, so staying
    // open does not fire another reset (which would wipe an error from a
    // write the user just triggered in this same session).
    expect(homeScreenStub.reset).toHaveBeenCalledTimes(1)
  })
})

describe('<AppsEditor> provenance gating', () => {
  beforeEach(() => {
    resetAllStubs()
    HTMLDialogElement.prototype.showModal = function showModal(): void {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function close(): void {
      this.removeAttribute('open')
    }
  })

  afterEach(() => {
    cleanup()
    restoreOrDelete('showModal', originalShowModal)
    restoreOrDelete('close', originalClose)
  })

  test('renders an enable toggle for every provenance; Remove only for cloud', () => {
    const apps: readonly AppEntry[] = [
      makeApp({ id: 'system-app', name: 'System App', provenance: 'system' }),
      makeApp({ id: 'self-app', name: 'Self App', provenance: 'self-hosted' }),
      makeApp({ id: 'cloud-app', name: 'Cloud App', provenance: 'cloud' }),
    ]
    render(<AppsEditor open apps={apps} onClose={() => {}} />)

    // Every row exposes an enable toggle — `enabled` is homescreen curation,
    // persisted via `PUT /home-screen`, which accepts all provenances.
    expect(rowToggles()).toHaveLength(3)
    // Only the cloud row is content-editable, so it's the only Remove on screen.
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
  })

  test('non-cloud rows show a read-only provenance tag (matching the tiles casing)', () => {
    const apps: readonly AppEntry[] = [
      makeApp({ id: 'system-app', name: 'System App', provenance: 'system' }),
      makeApp({ id: 'self-app', name: 'Self App', provenance: 'self-hosted' }),
    ]
    render(<AppsEditor open apps={apps} onClose={() => {}} />)

    // The provenance tag shares `provenanceLabel` with the home tiles, so casing
    // agrees — `Self-Hosted`, not `Self-hosted`.
    expect(screen.getByText('System')).toBeDefined()
    expect(screen.getByText('Self-Hosted')).toBeDefined()
    expect(screen.queryByText('Self-hosted')).toBeNull()
    // Still no Remove for non-cloud (content edits 409 for those kinds).
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  test('toggling a non-cloud row PUTs the whole home screen with that flag flipped', () => {
    // The enable toggle persists for every provenance through the same
    // `PUT /home-screen` writer — here disabling a system app.
    const apps: readonly AppEntry[] = [
      makeApp({ id: 'sys', name: 'System', provenance: 'system', enabled: true }),
      makeApp({ id: 'cloud-app', name: 'Cloud App', provenance: 'cloud', enabled: true }),
    ]
    render(<AppsEditor open apps={apps} onClose={() => {}} />)

    const [systemToggle] = rowToggles()
    expect(systemToggle).toBeDefined()
    systemToggle?.click()
    expect(homeScreenStub.mutate).toHaveBeenCalledWith([
      { id: 'sys', enabled: false },
      { id: 'cloud-app', enabled: true },
    ])
  })

  test('disables the toggles while a home-screen PUT is in flight', () => {
    // A reorder PUT from the home screen (a *separate* mutation instance) shows
    // up via the shared `useIsMutating` key — block toggling so it can't re-PUT
    // the pre-reorder order and revert the drag.
    isMutatingRef.count = 1
    const apps: readonly AppEntry[] = [
      makeApp({ id: 'cloud-app', name: 'Cloud App', provenance: 'cloud' }),
    ]
    const { container } = render(<AppsEditor open apps={apps} onClose={() => {}} />)

    // The fieldset wrapping every control is disabled, so the row toggles can't
    // fire mid-reorder.
    const fieldset = container.querySelector('fieldset')
    expect(fieldset?.disabled).toBe(true)
  })

  test('a cloud Remove click fires the delete mutation for that app', () => {
    const apps: readonly AppEntry[] = [
      makeApp({ id: 'cloud-app', name: 'Cloud App', provenance: 'cloud' }),
    ]
    render(<AppsEditor open apps={apps} onClose={() => {}} />)

    screen.getByRole('button', { name: 'Remove' }).click()
    expect(deleteStub.mutate).toHaveBeenCalledWith({ id: 'cloud-app' })
  })

  test('toggling a cloud row PUTs the whole home screen with that flag flipped', () => {
    // `enabled` is homescreen-curation state: the toggle re-PUTs the full list
    // (every provenance, current order preserved) with only the toggled app's
    // flag changed. Every row now has a toggle, so target the cloud row's (the
    // second, in `apps` order).
    const apps: readonly AppEntry[] = [
      makeApp({ id: 'sys', name: 'System', provenance: 'system', enabled: true }),
      makeApp({ id: 'cloud-app', name: 'Cloud App', provenance: 'cloud', enabled: true }),
    ]
    render(<AppsEditor open apps={apps} onClose={() => {}} />)

    const cloudToggle = rowToggles()[1]
    expect(cloudToggle).toBeDefined()
    cloudToggle?.click()
    expect(homeScreenStub.mutate).toHaveBeenCalledWith([
      { id: 'sys', enabled: true },
      { id: 'cloud-app', enabled: false },
    ])
  })
})
