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

vi.mock('../src/queries.ts', () => ({
  useAppsAdminUpdateMutation: () => updateStub,
  useAppsAdminCreateMutation: () => createStub,
  useAppsAdminDeleteMutation: () => deleteStub,
}))

import type { AppEntry } from '../src/queries.ts'
import { AppsEditor } from '../src/screens/apps-editor.tsx'

// Helpers
const NO_APPS: readonly AppEntry[] = []

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

  test('clears the stale error from the DOM after the reset clears the mutation', () => {
    // Arrange — a failed write left a stale error and the dialog is
    // closed (the bug's pre-condition: `Dialog` keeps children mounted,
    // so the error survives the close).
    updateStub.error = new Error('stale failure')
    const { rerender } = renderEditor(false)

    // Act 1 — reopen. The editor's open-transition effect calls
    // `reset()`. In production react-query's `reset()` flips the
    // mutation's `error` to null and re-renders subscribers; model that
    // settled post-reset state by clearing the stub before the
    // re-render the reset would have triggered.
    rerender(<AppsEditor open apps={NO_APPS} onClose={() => {}} />)
    expect(updateStub.reset).toHaveBeenCalledTimes(1)
    updateStub.error = null

    // Act 2 — the re-render react-query's reset would schedule.
    rerender(<AppsEditor open apps={NO_APPS} onClose={() => {}} />)

    // Assert — no alert: the stale error is gone, so reopening no longer
    // flashes the previous session's failure.
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
