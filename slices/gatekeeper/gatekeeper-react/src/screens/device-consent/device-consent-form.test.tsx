import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import type { DeviceConsent } from '../../queries/index.ts'
import { DeviceConsentForm } from './device-consent-form.tsx'

/**
 * `DeviceConsentForm` is the lifted, shared body of the public,
 * in-settings, and Tauri-modal consent surfaces; all the consent logic
 * lives here (scope selection, approve vs deny, result handling), so this
 * is the unit worth testing.
 *
 * The form drives `useDeviceConsentMutation`, which reads `runAuthed` from
 * router context (`useRouteContext`) and runs through a real `useMutation`.
 * Following the package's mutation tests, we stub only the transport:
 * mock `useRouteContext` to feed a `runAuthedStub`, wrap in a real
 * `QueryClientProvider`, and let `runAuthedStub` resolve/reject to drive
 * the server's decision deterministically.
 *
 * Note on the `errorMessage` precedence (`mutationError ?? denied`): a
 * state where both are set is not reachable through the UI — both
 * `handleApprove`/`handleDecline` reset `denied` before mutating, and
 * TanStack clears `error` when a new mutation starts — so we cover the two
 * reachable branches (a real error is shown; a server denial is shown)
 * rather than fabricating the impossible combined state.
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
  test('renders the consent details and one selected checkbox per requested scope', () => {
    // Arrange / Act
    renderConsentForm(makeConsent(), vi.fn())

    // Assert — identifying details are shown…
    expect(screen.getByText('BCDF-GHJK')).toBeDefined()
    expect(screen.getByText('Acme CLI')).toBeDefined()

    // …and every requested scope renders as a pre-checked checkbox.
    const observation = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'patient/Observation.read',
    })
    const condition = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'patient/Condition.read',
    })
    expect(observation.checked).toBe(true)
    expect(condition.checked).toBe(true)

    // With everything selected the button is the plain "Approve" (no count).
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined()
  })

  test('renders the device-authorization chrome: intro line, pairing-code label, and footnote', () => {
    // Arrange / Act
    renderConsentForm(makeConsent(), vi.fn())

    // Assert
    expect(screen.getByText('A new device is requesting access to your account.')).toBeDefined()
    expect(screen.getByText('Pairing code')).toBeDefined()
    expect(screen.getByText('Only approve devices you recognize.')).toBeDefined()
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

  test('reflects a partial selection in the Approve label and still approves', async () => {
    // Arrange
    runAuthedStub.mockResolvedValueOnce({ status: 'approved' })
    const onDone = vi.fn()
    const { user } = renderConsentForm(makeConsent(), onDone)

    // Act — drop one of the two requested scopes.
    await user.click(screen.getByRole('checkbox', { name: 'patient/Condition.read' }))

    // Assert — label now carries the running count, and approval still works.
    const approve = screen.getByRole('button', { name: 'Approve (1/2)' })
    await user.click(approve)
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1)
    })
  })

  test('disables Approve when every scope is deselected', async () => {
    // Arrange
    const { user } = renderConsentForm(makeConsent(), vi.fn())

    // Act — deselect both scopes.
    await user.click(screen.getByRole('checkbox', { name: 'patient/Observation.read' }))
    await user.click(screen.getByRole('checkbox', { name: 'patient/Condition.read' }))

    // Assert — nothing to grant, so Approve is disabled.
    expect(screen.getByRole('button', { name: 'Approve (0/2)' }).hasAttribute('disabled')).toBe(
      true
    )
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

  test('clears the denial message when a scope is toggled for a fresh attempt', async () => {
    // Arrange — get the form into the denied state.
    runAuthedStub.mockResolvedValueOnce({ status: 'denied' })
    const { user } = renderConsentForm(makeConsent(), vi.fn())
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByRole('alert')

    // Act — re-toggle a scope to start over.
    await user.click(screen.getByRole('checkbox', { name: 'patient/Observation.read' }))

    // Assert — the stale denial copy is gone.
    expect(screen.queryByRole('alert')).toBeNull()
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
})

// Helpers

const makeConsent = (overrides?: Partial<DeviceConsent>): DeviceConsent => ({
  userCode: 'BCDF-GHJK',
  clientId: 'cli.acme.example',
  clientName: 'Acme CLI',
  requestedScopes: ['patient/Observation.read', 'patient/Condition.read'],
  ...overrides,
})

const renderConsentForm = (
  consent: DeviceConsent,
  onDone: () => void
): { readonly user: ReturnType<typeof userEvent.setup> } => {
  const queryClient = new QueryClient()
  const user = userEvent.setup()
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  render(<DeviceConsentForm consent={consent} onDone={onDone} />, { wrapper })
  return { user }
}
