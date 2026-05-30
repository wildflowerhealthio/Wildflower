import { cleanup, render, screen } from '@testing-library/react'
import type { AuthorizationStatus } from 'gatekeeper-core/clients'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { PollingResult } from '../src/routes/_open/gatekeeper/oauth-polling.$id.tsx'

/**
 * Pins the `oauth-polling` stream consumer's rendering decisions:
 * `PollingResult` is the deterministic status→view mapping every stream
 * emission flows into (`{(status) => <PollingResult status={status} />}`).
 * Testing it directly covers the consumer's actual branch logic — denied
 * / error / pending views and the approved-redirect side effect — without
 * the Suspense + forked-fiber timing of the full stream subscription
 * (`useStream` itself is covered by its own tests in react-kitchen-sink).
 */

// jsdom's `window.location.replace` is a non-configurable property, so it
// can't be spied directly. Swap the whole `location` for a stub exposing a
// `replace` spy (the only member `PollingResult` touches), and restore the
// original after each test.
const originalLocation = window.location
const replaceSpy = vi.fn<(url: string) => void>()

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test stub: PollingResult only reads `location.replace`
const locationStub = { replace: replaceSpy } as unknown as Location

beforeEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: locationStub })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  replaceSpy.mockReset()
})

describe('PollingResult', () => {
  test('renders the declined view for a denied status', () => {
    render(<PollingResult status={{ status: 'denied' }} />)
    expect(screen.getByText('Request Declined')).toBeTruthy()
    expect(screen.getByText('The authorization request was declined.')).toBeTruthy()
  })

  test('renders the error view with the server message for an error status', () => {
    render(<PollingResult status={{ status: 'error', message: 'something broke' }} />)
    expect(screen.getByText('Authorization Error')).toBeTruthy()
    expect(screen.getByText('something broke')).toBeTruthy()
  })

  test('renders the spinner for a pending heartbeat', () => {
    render(<PollingResult status={{ status: 'pending' }} />)
    expect(screen.getByText('Waiting for Approval')).toBeTruthy()
  })

  test('redirects (and shows the spinner) when the status becomes approved', () => {
    const status: AuthorizationStatus = {
      status: 'approved',
      redirect: 'https://example.com/done',
    }
    render(<PollingResult status={status} />)

    // Approved is a transient pre-redirect state: same spinner, plus the
    // navigation side effect fires from the effect.
    expect(screen.getByText('Waiting for Approval')).toBeTruthy()
    expect(replaceSpy).toHaveBeenCalledWith('https://example.com/done')
  })
})
