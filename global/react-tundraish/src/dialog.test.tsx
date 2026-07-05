import { fireEvent, render } from '@testing-library/react'
import { useState, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { Dialog } from './dialog.tsx'

// jsdom does not implement the native <dialog> element. Stub the methods we
// rely on per-test and restore the original descriptors after so the patches
// don't leak across test files.
const originalShowModalDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'showModal'
)
const originalCloseDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'close'
)

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

const ControlledDialog = ({
  initialOpen,
  onClose,
}: {
  readonly initialOpen: boolean
  readonly onClose?: () => void
}): JSX.Element => {
  const [open, setOpen] = useState(initialOpen)
  return (
    <Dialog
      open={open}
      onClose={() => {
        onClose?.()
        setOpen(false)
      }}
    >
      Body
    </Dialog>
  )
}

const ControlledDialogNonDismissable = ({
  initialOpen,
  onClose,
}: {
  readonly initialOpen: boolean
  readonly onClose?: () => void
}): JSX.Element => {
  const [open, setOpen] = useState(initialOpen)
  return (
    <Dialog
      open={open}
      dismissable={false}
      onClose={() => {
        onClose?.()
        setOpen(false)
      }}
    >
      Body
    </Dialog>
  )
}

describe('Dialog', () => {
  it('calls showModal when transitioning from closed to open', () => {
    // Arrange
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    const { rerender } = render(
      <Dialog open={false} onClose={vi.fn()}>
        Body
      </Dialog>
    )

    // Act
    rerender(
      <Dialog open={true} onClose={vi.fn()}>
        Body
      </Dialog>
    )

    // Assert
    expect(showModal).toHaveBeenCalledTimes(1)
  })

  it('calls close when transitioning from open to closed', () => {
    // Arrange
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close')
    const { rerender } = render(
      <Dialog open={true} onClose={vi.fn()}>
        Body
      </Dialog>
    )
    close.mockClear() // ignore close() that may fire from initial mount under StrictMode

    // Act
    rerender(
      <Dialog open={false} onClose={vi.fn()}>
        Body
      </Dialog>
    )

    // Assert — close should be called at least once during the close transition
    expect(close).toHaveBeenCalled()
  })

  it('fires onClose exactly once when the user clicks the backdrop', () => {
    // Arrange
    const onClose = vi.fn()
    render(<ControlledDialog initialOpen={true} onClose={onClose} />)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const dialog = document.querySelector('dialog') as HTMLDialogElement

    // Act — clicking on the dialog itself (currentTarget === target) is the
    // backdrop in this component's model.
    fireEvent.click(dialog, { target: dialog })

    // Assert
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('forwards the cancel event to the onCancel prop', () => {
    // Arrange
    const onCancel = vi.fn()
    render(
      <Dialog open={true} onClose={vi.fn()} onCancel={onCancel}>
        Body
      </Dialog>
    )
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const dialog = document.querySelector('dialog') as HTMLDialogElement

    // Act
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))

    // Assert
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  describe('non-dismissable (dismissable={false})', () => {
    it('omits the × close button', () => {
      // Arrange + Act
      render(
        <Dialog open={true} onClose={vi.fn()} dismissable={false}>
          Body
        </Dialog>
      )

      // Assert — the dismissable variant renders an `&#215;` text button.
      const closeButton = document.querySelector('button')
      expect(closeButton).toBeNull()
    })

    it('ignores backdrop clicks (no close, no onClose)', () => {
      // Arrange
      const onClose = vi.fn()
      const closeSpy = vi.spyOn(HTMLDialogElement.prototype, 'close')
      render(<ControlledDialogNonDismissable initialOpen={true} onClose={onClose} />)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const dialog = document.querySelector('dialog') as HTMLDialogElement
      closeSpy.mockClear()

      // Act
      fireEvent.click(dialog, { target: dialog })

      // Assert
      expect(closeSpy).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('preventDefaults the native cancel event and never calls onCancel', () => {
      // Arrange
      const onCancel = vi.fn()
      render(
        <Dialog open={true} onClose={vi.fn()} onCancel={onCancel} dismissable={false}>
          Body
        </Dialog>
      )
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const dialog = document.querySelector('dialog') as HTMLDialogElement
      const cancelEvent = new Event('cancel', { bubbles: false, cancelable: true })

      // Act
      fireEvent(dialog, cancelEvent)

      // Assert
      expect(cancelEvent.defaultPrevented).toBe(true)
      expect(onCancel).not.toHaveBeenCalled()
    })
  })

  it('restores focus to the previously focused element on close', () => {
    // Arrange
    const opener = document.createElement('button')
    opener.textContent = 'Opener'
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const { rerender } = render(
      <Dialog open={false} onClose={vi.fn()}>
        Body
      </Dialog>
    )
    rerender(
      <Dialog open={true} onClose={vi.fn()}>
        Body
      </Dialog>
    )

    // Act
    rerender(
      <Dialog open={false} onClose={vi.fn()}>
        Body
      </Dialog>
    )

    // Assert
    expect(document.activeElement).toBe(opener)
  })
})
