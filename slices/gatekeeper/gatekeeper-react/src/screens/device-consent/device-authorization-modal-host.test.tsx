import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { JSX, ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { DeviceAuthorizationModalHost } from './device-authorization-modal-host.tsx'

// The head is pushed natively over the bridge; drive it directly so the test
// pins the host's orchestration (open/close + local dismissal) without a
// provider or a live store.
let mockActiveHead: string | null = null

vi.mock('../../active-device-request/index.ts', () => ({
  useActiveDeviceRequest: (): string | null => mockActiveHead,
}))

// Stub the consent fetch so the dialog body never suspends or hits HTTP — the
// query's own behaviour is covered in queries-mutations.test.tsx.
vi.mock('../../queries/index.ts', () => ({
  useDeviceConsentQuery: (userCode: string): { data: { userCode: string } } => ({
    data: { userCode },
  }),
}))

// A stand-in form that exposes the threaded props and a single "done" button so
// the test can fire `onDone` the way an approve/deny resolution would.
vi.mock('./device-consent-form.tsx', () => ({
  DeviceConsentForm: ({
    consent,
    onDone,
    showHeading,
  }: {
    readonly consent: { readonly userCode: string }
    readonly onDone: () => void
    readonly showHeading?: boolean
  }): JSX.Element => (
    <div
      data-testid="consent-form"
      data-user-code={consent.userCode}
      data-show-heading={String(showHeading)}
    >
      <button type="button" onClick={onDone}>
        done
      </button>
    </div>
  ),
}))

// Replace the real <dialog>-backed component (jsdom can't drive showModal) with
// a transparent shell that surfaces the props the host controls.
vi.mock('react-tundraish', () => ({
  Dialog: ({
    open,
    dismissable,
    title,
    children,
  }: {
    readonly open: boolean
    readonly dismissable?: boolean
    readonly title?: ReactNode
    readonly children?: ReactNode
  }): JSX.Element => (
    <div data-testid="dialog" data-open={String(open)} data-dismissable={String(dismissable)}>
      <span data-testid="dialog-title">{title}</span>
      {children}
    </div>
  ),
}))

afterEach(() => {
  cleanup()
  mockActiveHead = null
  vi.clearAllMocks()
})

describe('DeviceAuthorizationModalHost', () => {
  test('keeps the dialog closed and empty when there is no active head', () => {
    mockActiveHead = null
    render(<DeviceAuthorizationModalHost />)

    expect(screen.getByTestId('dialog').dataset['open']).toBe('false')
    expect(screen.queryByTestId('consent-form')).toBeNull()
  })

  test('opens a non-dismissable, host-titled dialog with the headless form for an active head', () => {
    mockActiveHead = 'ABCD-1234'
    render(<DeviceAuthorizationModalHost />)

    const dialog = screen.getByTestId('dialog')
    expect(dialog.dataset['open']).toBe('true')
    expect(dialog.dataset['dismissable']).toBe('false')
    expect(screen.getByTestId('dialog-title').textContent).toBe('Device Authorization')

    const form = screen.getByTestId('consent-form')
    expect(form.dataset['userCode']).toBe('ABCD-1234')
    // The Dialog supplies the title, so the form must not render its own <h1>.
    expect(form.dataset['showHeading']).toBe('false')
  })

  test('dismisses locally the moment the form resolves, even while the head lingers', async () => {
    mockActiveHead = 'ABCD-1234'
    render(<DeviceAuthorizationModalHost />)
    expect(screen.getByTestId('dialog').dataset['open']).toBe('true')

    fireEvent.click(screen.getByText('done'))

    // The head is still 'ABCD-1234', but the handled code is remembered, so the
    // popup goes away without waiting for the native side to push a new head.
    await waitFor(() => {
      expect(screen.getByTestId('dialog').dataset['open']).toBe('false')
    })
    expect(screen.queryByTestId('consent-form')).toBeNull()
  })

  test('re-opens for a genuinely new head after the previous one was handled', async () => {
    mockActiveHead = 'ABCD-1234'
    const { rerender } = render(<DeviceAuthorizationModalHost />)
    fireEvent.click(screen.getByText('done'))
    await waitFor(() => {
      expect(screen.getByTestId('dialog').dataset['open']).toBe('false')
    })

    mockActiveHead = 'WXYZ-5678'
    rerender(<DeviceAuthorizationModalHost />)

    const dialog = screen.getByTestId('dialog')
    expect(dialog.dataset['open']).toBe('true')
    expect(screen.getByTestId('consent-form').dataset['userCode']).toBe('WXYZ-5678')
  })
})
