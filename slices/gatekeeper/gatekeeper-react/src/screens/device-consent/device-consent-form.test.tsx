import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import type { DeviceConsent } from '../../queries/index.ts'
import { DeviceConsentForm } from './device-consent-form.tsx'

/**
 * `DeviceConsentForm` is the lifted, shared body of the public, in-settings, and
 * Tauri-modal consent surfaces; all the form's own logic lives here (the
 * expandable {@link ScopePicker} wiring, the device-name field, approve vs deny,
 * result handling). The scope-editing mechanics themselves are covered by
 * `scopes-react`'s `ScopePicker` tests, so this unit focuses on the form's
 * chrome, decision wiring, and the settings rename affordance.
 *
 * The form drives `useDeviceConsentMutation`, which reads `runAuthed` from router
 * context (`useRouteContext`) and runs through a real `useMutation`. Following the
 * package's mutation tests, we stub only the transport: mock `useRouteContext` to
 * feed a `runAuthedStub`, wrap in a real `QueryClientProvider`, and let
 * `runAuthedStub` resolve/reject to drive the server's decision deterministically.
 */

const runAuthedStub = vi.fn((_effect: unknown): Promise<unknown> => Promise.resolve(undefined))

vi.mock('@tanstack/react-router', () => ({
  // Mirrors `useRouteContext({ from, select })`: `useRunAuthed` passes a
  // `select` that pulls `context.runAuthed`.
  useRouteContext: ({
    select,
  }: {
    select: (context: { runAuthed: unknown }) => unknown
  }): unknown => select({ runAuthed: runAuthedStub }),
}))

beforeEach(() => {
  runAuthedStub.mockReset()
  // Sensible default decision; each test overrides the first call.
  runAuthedStub.mockResolvedValue({ status: 'approved' })
})

afterEach(() => {
  cleanup()
})

describe('DeviceConsentForm', () => {
  test('renders the device-authorization chrome: intro, pairing code, app, footnote', () => {
    // Arrange / Act
    renderConsentForm(makeConsent(), vi.fn())

    // Assert
    expect(screen.getByText('A new device is requesting access to your account.')).toBeDefined()
    expect(screen.getByText('BCDF-GHJK')).toBeDefined()
    expect(screen.getByText('Acme CLI')).toBeDefined()
    expect(screen.getByText('Only approve devices you recognize.')).toBeDefined()
    // The scope picker mounted (its detail grid shows the requested scope string).
    expect(screen.getByText('patient/Observation.rs')).toBeDefined()
  })

  test('approves and finishes when the server records the grant', async () => {
    // Arrange
    runAuthedStub.mockResolvedValueOnce({ status: 'approved' })
    const onDone = vi.fn()
    const { user } = renderConsentForm(makeConsent(), onDone)

    // Act
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    // Assert
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1)
    })
  })

  test('disables Approve when nothing is granted (empty request, nothing to add)', () => {
    // A request with no scopes and an empty expansion envelope has an empty draft,
    // which the backend treats as a deny — so Approve is blocked.
    renderConsentForm(makeConsent({ requestedScopes: [], allowedScopes: [] }), vi.fn())
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(true)
  })

  test('shows a denial notice and stays on the form when an approval is denied', async () => {
    // Arrange — the server rejects the approval (status 'denied').
    runAuthedStub.mockResolvedValueOnce({ status: 'denied' })
    const onDone = vi.fn()
    const { user } = renderConsentForm(makeConsent(), onDone)

    // Act
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    // Assert — message shown, flow not completed.
    expect((await screen.findByRole('alert')).textContent).toBe('Authorization request was denied.')
    expect(onDone).not.toHaveBeenCalled()
  })

  test('surfaces the underlying error and stays on the form when the request fails', async () => {
    // Arrange — the transport throws (e.g. a network failure).
    runAuthedStub.mockRejectedValueOnce(new Error('Network unreachable'))
    const onDone = vi.fn()
    const { user } = renderConsentForm(makeConsent(), onDone)

    // Act
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    // Assert — the real error is shown (not the denial copy), flow not done.
    expect((await screen.findByRole('alert')).textContent).toBe('Network unreachable')
    expect(onDone).not.toHaveBeenCalled()
  })

  test('declines and finishes when the server records the denial', async () => {
    // Arrange
    runAuthedStub.mockResolvedValueOnce({ status: 'denied' })
    const onDone = vi.fn()
    const { user } = renderConsentForm(makeConsent(), onDone)

    // Act
    await user.click(screen.getByRole('button', { name: 'Decline' }))

    // Assert — declining is a completed decision (onDone), not an error.
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('disables both actions while a decision is in flight', async () => {
    // Arrange — hold the transport pending so we can observe the in-flight UI.
    let resolveDecision!: (result: unknown) => void
    runAuthedStub.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDecision = resolve
      })
    )
    const onDone = vi.fn()
    const { user } = renderConsentForm(makeConsent(), onDone)

    // Act
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    // Assert — both buttons disabled so a second click can't double-submit.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(true)
    })
    expect(screen.getByRole('button', { name: 'Decline' }).hasAttribute('disabled')).toBe(true)
    expect(onDone).not.toHaveBeenCalled()

    // Settle so the component isn't left mid-flight.
    resolveDecision({ status: 'approved' })
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1)
    })
  })

  describe('device name', () => {
    test('read-only surface shows the supplied name and no name input', () => {
      renderConsentForm(makeConsent({ deviceName: "Ada's laptop" }), vi.fn())
      expect(screen.getByText("Ada's laptop")).toBeDefined()
      expect(screen.queryByRole('textbox', { name: /Device name/ })).toBeNull()
    })

    test('settings surface (editableName) offers an editable, pre-seeded name field', async () => {
      const { user } = renderConsentForm(
        makeConsent({ deviceName: 'Reception iPad' }),
        vi.fn(),
        true
      )
      const field = screen.getByRole<HTMLInputElement>('textbox', { name: /Device name/ })
      expect(field.value).toBe('Reception iPad')

      // The approver can rename it before approving.
      await user.clear(field)
      await user.type(field, 'Lobby kiosk')
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: /Device name/ }).value).toBe(
        'Lobby kiosk'
      )
    })
  })
})

// Helpers

const makeConsent = (overrides?: Partial<DeviceConsent>): DeviceConsent => ({
  userCode: 'BCDF-GHJK',
  clientId: 'cli.acme.example',
  clientName: 'Acme CLI',
  deviceName: null,
  requestedScopes: ['patient/Observation.rs'],
  // The client is allowed a wider set — device consent is expandable.
  allowedScopes: ['patient/*.cruds'],
  ...overrides,
})

const renderConsentForm = (
  consent: DeviceConsent,
  onDone: () => void,
  editableName = false
): { readonly user: ReturnType<typeof userEvent.setup> } => {
  const queryClient = new QueryClient()
  const user = userEvent.setup()
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  render(<DeviceConsentForm consent={consent} onDone={onDone} editableName={editableName} />, {
    wrapper,
  })
  return { user }
}
