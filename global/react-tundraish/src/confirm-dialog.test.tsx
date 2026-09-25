import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { ConfirmDialog } from './confirm-dialog.tsx'

// jsdom does not implement the native <dialog> element; stub the two methods
// `Dialog` drives, and restore the originals so the patch can't leak.
const originalShowModalDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'showModal'
)
const originalCloseDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'close'
)

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
})

afterEach(() => {
  restoreOrDelete('showModal', originalShowModalDescriptor)
  restoreOrDelete('close', originalCloseDescriptor)
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('ConfirmDialog', () => {
  it('should ask its question under the title with the confirm label and Cancel', () => {
    // Arrange + Act
    renderConfirm({ confirmLabel: 'Revoke' })

    // Assert
    expect(screen.getByRole('heading', { name: 'Revoke Access' })).toBeDefined()
    expect(screen.getByText('Revoke access for "SMART Growth Chart"?')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined()
  })

  it('should call onConfirm when the confirm button is clicked', () => {
    // Arrange
    const onConfirm = vi.fn()
    renderConfirm({ onConfirm })

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    // Assert
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('should call onCancel from Cancel and from the ×', () => {
    // Arrange
    const onCancel = vi.fn()
    renderConfirm({ onCancel })

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    // Assert
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('should hold the confirm button while pending, so a second click sends nothing', () => {
    // Arrange
    const onConfirm = vi.fn()
    renderConfirm({ pending: true, onConfirm })
    const confirm = screen.getByRole('button', { name: 'Revoke' })

    // Act
    fireEvent.click(confirm)

    // Assert
    expect(confirm).toHaveProperty('disabled', true)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', false)
  })

  it('should paint the confirm button red only when destructive', () => {
    fc.assert(
      fc.property(fc.boolean(), (destructive) => {
        // Arrange + Act
        renderConfirm({ destructive })

        // Assert
        const confirm = screen.getByRole('button', { name: 'Revoke' })
        expect(confirm.classList.contains('accent-red')).toBe(destructive)
        cleanup()
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it('should always enable confirm exactly when nothing is pending, whatever its label', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).map((label) => `${label}!`),
        fc.boolean(),
        (confirmLabel, pending) => {
          // Arrange + Act
          renderConfirm({ confirmLabel, pending })

          // Assert
          const [confirm] = screen
            .getAllByRole('button')
            .filter((b) => b.textContent === confirmLabel)
          expect(confirm).toHaveProperty('disabled', pending)
          cleanup()
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

// Helpers

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

interface ConfirmOverrides {
  readonly confirmLabel?: string
  readonly destructive?: boolean
  readonly pending?: boolean
  readonly onConfirm?: () => void
  readonly onCancel?: () => void
}

/** An open "Revoke Access" confirm; each test overrides only what it checks. */
const renderConfirm = ({
  confirmLabel = 'Revoke',
  destructive = true,
  pending = false,
  onConfirm = vi.fn(),
  onCancel = vi.fn(),
}: ConfirmOverrides): void => {
  render(
    <ConfirmDialog
      open={true}
      title="Revoke Access"
      confirmLabel={confirmLabel}
      destructive={destructive}
      pending={pending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      Revoke access for &quot;SMART Growth Chart&quot;?
    </ConfirmDialog>
  )
}
