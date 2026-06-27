import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

// `AppsEditor` reads its three mutations from `queries.ts`. The reset
// bug under test is purely about the editor's reaction to the `open`
// prop transition — not the mutations' transport — so stub the three
// hooks with controllable mutation objects. Each stub exposes a spy
// `reset` (so we can assert it fires on open) and a settable `error` (so
// we can plant a stale error the way a failed write would leave one
// behind while `Dialog` keeps the children mounted).
const { updateStub, createStub, deleteStub } = vi.hoisted(() => {
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
    updateStub: makeMutation(),
    createStub: makeMutation(),
    deleteStub: makeMutation(),
  }
})

vi.mock('../queries.ts', () => ({
  useAppsAdminUpdateMutation: () => updateStub,
  useAppsAdminCreateMutation: () => createStub,
  useAppsAdminDeleteMutation: () => deleteStub,
}))

import type { AppEntry } from '../queries.ts'
import { AppsEditor } from './apps-editor.tsx'

// Helpers
const NO_APPS: readonly AppEntry[] = []

// A row of each provenance — `provenance` drives whether the editable controls
// (enable-toggle + Remove) render. The other flags are the lightest valid wire
// shape; the editor reads only `id`, `name`, `subtitle`, `enabled`, `provenance`.
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

const resetAllStubs = (): void => {
  for (const stub of [updateStub, createStub, deleteStub]) {
    stub.mutate.mockClear()
    stub.reset.mockClear()
    stub.isPending = false
    stub.error = null
  }
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
    // oxlint-disable unicorn/consistent-function-scoping
    HTMLDialogElement.prototype.showModal = function showModal(): void {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function close(): void {
      this.removeAttribute('open')
    }
    // oxlint-enable unicorn/consistent-function-scoping
  })

  afterEach(() => {
    cleanup()
    restoreOrDelete('showModal', originalShowModal)
    restoreOrDelete('close', originalClose)
  })

  test('shows a settled mutation error while open', () => {
    // Arrange — a previous write failed; its error persists on the stub.
    updateStub.error = new Error('toggle failed')

    // Act
    renderEditor(true)

    // Assert — the editor surfaces the stale error in its alert region.
    expect(screen.getByRole('alert').textContent).toBe('toggle failed')
  })

  test('resets all three mutations when the dialog transitions to open', () => {
    // Arrange — start closed so the open-transition effect has not run.
    const { rerender } = renderEditor(false)
    expect(updateStub.reset).not.toHaveBeenCalled()

    // Act — open the dialog.
    rerender(<AppsEditor open apps={NO_APPS} onClose={() => {}} />)

    // Assert — every mutation is reset on the open transition, so no
    // stale error from a prior session can leak into the fresh open.
    expect(updateStub.reset).toHaveBeenCalledTimes(1)
    expect(createStub.reset).toHaveBeenCalledTimes(1)
    expect(deleteStub.reset).toHaveBeenCalledTimes(1)
  })

  test('surfaces the alert from the live mutation error, not a stale snapshot', () => {
    // Arrange — open with a write error present on the mutation.
    updateStub.error = new Error('write failed')
    const { rerender } = renderEditor(true)
    expect(screen.getByRole('alert').textContent).toBe('write failed')

    // Act — react-query's `reset()` clears `mutation.error` and re-renders
    // subscribers. Drive that from the source the component reads: flip the
    // live mutation `error` to null and rerender.
    updateStub.error = null
    rerender(<AppsEditor open apps={NO_APPS} onClose={() => {}} />)

    // Assert — the alert follows the live mutation error to null, proving
    // the editor renders the alert off `updateMutation.error` rather than a
    // value the test plants independently of the component.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('does not re-reset on re-renders while already open', () => {
    // Arrange — open once (one reset), then re-render still open.
    const { rerender } = renderEditor(true)
    expect(updateStub.reset).toHaveBeenCalledTimes(1)

    // Act — a no-op prop change that keeps `open` true.
    rerender(<AppsEditor open apps={NO_APPS} onClose={() => {}} />)

    // Assert — the effect is keyed on the `open` transition, so staying
    // open does not fire another reset (which would wipe an error from a
    // write the user just triggered in this same session).
    expect(updateStub.reset).toHaveBeenCalledTimes(1)
  })
})

describe('<AppsEditor> provenance gating', () => {
  beforeEach(() => {
    resetAllStubs()
    // oxlint-disable unicorn/consistent-function-scoping
    HTMLDialogElement.prototype.showModal = function showModal(): void {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function close(): void {
      this.removeAttribute('open')
    }
    // oxlint-enable unicorn/consistent-function-scoping
  })

  afterEach(() => {
    cleanup()
    restoreOrDelete('showModal', originalShowModal)
    restoreOrDelete('close', originalClose)
  })

  test('renders the enable-toggle + Remove only for cloud rows', () => {
    const apps: readonly AppEntry[] = [
      makeApp({ id: 'cloud-app', name: 'Cloud App', provenance: 'cloud' }),
    ]
    render(<AppsEditor open apps={apps} onClose={() => {}} />)

    // The cloud row carries an editable surface: a checkbox + a Remove button.
    expect(screen.getByRole('checkbox')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDefined()
  })

  test('renders system / self-hosted rows read-only — no Remove, no toggle', () => {
    const apps: readonly AppEntry[] = [
      makeApp({ id: 'system-app', name: 'System App', provenance: 'system' }),
      makeApp({ id: 'self-app', name: 'Self App', provenance: 'self-hosted' }),
    ]
    render(<AppsEditor open apps={apps} onClose={() => {}} />)

    // Neither non-cloud row exposes the cloud-admin controls — those endpoints
    // `409` for non-cloud apps, so firing them would always fail.
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    // The rows still render (read-only), labelled by name.
    expect(screen.getByText('System App')).toBeDefined()
    expect(screen.getByText('Self App')).toBeDefined()
  })

  test('a cloud Remove click fires the delete mutation for that app', () => {
    const apps: readonly AppEntry[] = [
      makeApp({ id: 'cloud-app', name: 'Cloud App', provenance: 'cloud' }),
    ]
    render(<AppsEditor open apps={apps} onClose={() => {}} />)

    screen.getByRole('button', { name: 'Remove' }).click()
    expect(deleteStub.mutate).toHaveBeenCalledWith({ id: 'cloud-app' })
  })
})
