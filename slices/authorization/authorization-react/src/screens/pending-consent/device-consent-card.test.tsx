import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { Effect, Layer } from 'effect'
import { type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  deviceConsentMutationOptions,
  useRunAuthed,
  type DeviceConsent,
} from '../../queries/index.ts'
import { DeviceConsentCard } from './device-consent-card.tsx'

/**
 * `DeviceConsentCard`'s logic: the expandable {@link ScopePicker} wiring, the
 * device-name field, approve vs deny, result handling. The scope-editing
 * mechanics themselves are covered by `scopes-react`'s `ScopePicker` tests, so
 * this unit focuses on the card's chrome and decision wiring.
 *
 * The card sends its decision through a real `useMutation` over
 * `deviceConsentMutationOptions`, on the runner `useRunAuthed` reads from
 * router context (`useRouteContext`). Following the package's mutation tests,
 * we stub only the transport: mock `useRouteContext` to feed a
 * `runAuthedStub`, wrap in a real `QueryClientProvider`, and let
 * `runAuthedStub` resolve/reject to drive the server's decision
 * deterministically.
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

describe('DeviceConsentCard', () => {
  test('renders the device-authorization chrome: intro, pairing code, app, footnote', () => {
    // Arrange / Act
    renderCard(makeConsent(), vi.fn())

    // Assert
    expect(screen.getByText('A new device is requesting access to your account.')).toBeDefined()
    expect(screen.getByText('BCDF-GHJK')).toBeDefined()
    expect(screen.getByText('Acme CLI')).toBeDefined()
    expect(screen.getByText('Only approve devices you recognize.')).toBeDefined()
    // The scope picker mounted on its summary view, framing the ask in the
    // asking voice (the client name is the subject when no device name is set).
    expect(screen.getByText('Acme CLI is asking to')).toBeDefined()
    expect(screen.queryByText('patient/Observation.rs')).toBeNull()
  })

  test('withholds the whose-records selector and which-patient pill', () => {
    // Device-auth is pinned to all-patients (the FHIR server's patient/ support is too weak
    // to offer a one-patient subject), so neither the selector nor the pill appears — even
    // though the allowed set covers system/.
    renderCard(makeConsent({ allowedScopes: ['system/*.cruds'] }), vi.fn())

    expect(screen.queryByRole('radio', { name: /Just one patient/ })).toBeNull()
    expect(screen.queryByRole('radio', { name: /All patients/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Select a Patient/ })).toBeNull()
  })

  test('honors a device-requested patient/ scope and approves it with no launch patient', async () => {
    // "Apps can still use them if that's what they expect": a device may request patient/
    // scopes and have them granted as-is. With no one-patient subject to pick, the approve
    // payload carries the requested scope untouched and no `patient` claim.
    let capturedPayload: unknown
    const clientLayer = Layer.succeed(AuthorizationServerHttpApiClient, {
      devices: {
        ApproveDeviceConsent: (input: { readonly payload: unknown }) => {
          capturedPayload = input.payload
          return Effect.succeed({ status: 'approved' })
        },
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test stub: only `devices.ApproveDeviceConsent` is touched on this path
    } as unknown as AuthorizationServerHttpApiClient['Type'])
    runAuthedStub.mockImplementationOnce((effect) =>
      Effect.runPromise(
        Effect.provide(
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test runner: the mutation's Effect needs only the stubbed client
          effect as Effect.Effect<unknown, never, AuthorizationServerHttpApiClient>,
          clientLayer
        )
      )
    )
    const onDone = vi.fn()
    const { user } = renderCard(makeConsent({ allowedScopes: ['system/*.cruds'] }), onDone)

    // Act — approve straight away; there is no patient to pick.
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    // Assert — the requested patient/ scope rides through, with no `patient` in the body.
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1)
    })
    expect(capturedPayload).toEqual({ approvedScopes: ['patient/Observation.rs'] })
  })

  test('approves and finishes when the server records the grant', async () => {
    // Arrange
    runAuthedStub.mockResolvedValueOnce({ status: 'approved' })
    const onDone = vi.fn()
    const { user } = renderCard(makeConsent(), onDone)

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
    renderCard(makeConsent({ requestedScopes: [], allowedScopes: [] }), vi.fn())
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(true)
  })

  test('shows a denial notice and stays on the form when an approval is denied', async () => {
    // Arrange — the server rejects the approval (status 'denied').
    runAuthedStub.mockResolvedValueOnce({ status: 'denied' })
    const onDone = vi.fn()
    const { user } = renderCard(makeConsent(), onDone)

    // Act
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    // Assert — message shown, flow not completed.
    // `ErrorBanner` prefixes an aria-hidden glyph + sr-only "Error:", so assert
    // the message is present rather than the exact textContent.
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Authorization request was denied.'
    )
    expect(onDone).not.toHaveBeenCalled()
  })

  test('surfaces the underlying error and stays on the form when the request fails', async () => {
    // Arrange — the transport throws (e.g. a network failure).
    runAuthedStub.mockRejectedValueOnce(new Error('Network unreachable'))
    const onDone = vi.fn()
    const { user } = renderCard(makeConsent(), onDone)

    // Act
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    // Assert — the real error is shown (not the denial copy), flow not done.
    expect((await screen.findByRole('alert')).textContent).toContain('Network unreachable')
    expect(onDone).not.toHaveBeenCalled()
  })

  test('says to approve only recognized devices above the decision', () => {
    renderCard(makeConsent(), vi.fn())

    const footnote = screen.getByText('Only approve devices you recognize.')
    expect(
      footnote.compareDocumentPosition(screen.getByRole('button', { name: 'Decline' })) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  test('declines and finishes when the server records the denial', async () => {
    // Arrange
    runAuthedStub.mockResolvedValueOnce({ status: 'denied' })
    const onDone = vi.fn()
    const { user } = renderCard(makeConsent(), onDone)

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
    const { user } = renderCard(makeConsent(), onDone)

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
    test('shows the supplied name, read only', () => {
      renderCard(makeConsent({ deviceName: "Ada's laptop" }), vi.fn())
      expect(screen.getByText("Ada's laptop")).toBeDefined()
      expect(screen.queryByRole('textbox', { name: /Device name/ })).toBeNull()
    })
  })

  describe('a browser pairing', () => {
    /** A remote browser's pairing: it starts from launching apps, and may be widened up to the Owner's scopes. */
    const browserConsent = makeConsent({
      kind: 'browser',
      clientId: 'cb9bbe139845cae9654b7909d60d274f',
      clientName: 'Wildflower Browsers',
      deviceName: 'Firefox on Linux',
      requestedScopes: ['wildflower/launch'],
      allowedScopes: ['system/*.cruds', 'wildflower/*.cruds', 'wildflower/launch'],
    })

    test('says a browser wants to sign in, by its name, marked remote, with no application', () => {
      renderCard(browserConsent, vi.fn())

      expect(screen.getByText('A browser wants to sign in to your server.')).toBeDefined()
      expect(screen.getByText('Firefox on Linux')).toBeDefined()
      expect(screen.getByText('Remote')).toBeDefined()
      expect(
        screen.getByText('Only approve a browser you recognize. It signs in for 24 hours.')
      ).toBeDefined()
      expect(screen.queryByText('Wildflower Browsers')).toBeNull()
      expect(screen.queryByText('A new device is requesting access to your account.')).toBeNull()
    })

    test('approves the ticks it starts from', async () => {
      let capturedPayload: unknown
      const clientLayer = Layer.succeed(AuthorizationServerHttpApiClient, {
        devices: {
          ApproveDeviceConsent: (input: { readonly payload: unknown }) => {
            capturedPayload = input.payload
            return Effect.succeed({ status: 'approved' })
          },
        },
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test stub: only `devices.ApproveDeviceConsent` is touched on this path
      } as unknown as AuthorizationServerHttpApiClient['Type'])
      runAuthedStub.mockImplementationOnce((effect) =>
        Effect.runPromise(
          Effect.provide(
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test runner: the mutation's Effect needs only the stubbed client
            effect as Effect.Effect<unknown, never, AuthorizationServerHttpApiClient>,
            clientLayer
          )
        )
      )
      const onDone = vi.fn()
      const { user } = renderCard(browserConsent, onDone)

      await user.click(screen.getByRole('button', { name: 'Approve' }))

      await waitFor(() => {
        expect(onDone).toHaveBeenCalledTimes(1)
      })
      expect(capturedPayload).toEqual({ approvedScopes: ['wildflower/launch'] })
    })
  })
})

// Helpers

const makeConsent = (overrides?: Partial<DeviceConsent>): DeviceConsent => ({
  kind: 'device',
  userCode: 'BCDF-GHJK',
  clientId: 'cli.acme.example',
  clientName: 'Acme CLI',
  deviceName: null,
  requestedScopes: ['patient/Observation.rs'],
  // The client is allowed a wider set — device consent is expandable.
  allowedScopes: ['patient/*.cruds'],
  missingApprovalScopes: [],
  ...overrides,
})

/** The card on a real decision mutation over the stubbed runner. */
const CardOnStubbedRunner = ({
  consent,
  onDone,
}: {
  readonly consent: DeviceConsent
  readonly onDone: () => void
}): JSX.Element => {
  const consentMutation = useMutation(deviceConsentMutationOptions(useRunAuthed()))
  return <DeviceConsentCard consent={consent} consentMutation={consentMutation} onDone={onDone} />
}

const renderCard = (
  consent: DeviceConsent,
  onDone: () => void
): { readonly user: ReturnType<typeof userEvent.setup> } => {
  const queryClient = new QueryClient()
  const user = userEvent.setup()
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  render(<CardOnStubbedRunner consent={consent} onDone={onDone} />, {
    wrapper,
  })
  return { user }
}
