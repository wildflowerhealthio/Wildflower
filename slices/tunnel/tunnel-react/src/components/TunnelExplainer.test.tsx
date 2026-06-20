import { render, screen } from '@testing-library/react'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import type { TunnelState } from '../queries.ts'
import { TunnelExplainer } from './TunnelExplainer.tsx'

const OPEN_WITH_HOST: TunnelState = {
  ...Tunnel.freshTunnelState,
  requestedRunning: true,
  running: true,
  publicHost: 'ruth.wildflowerhealth.io',
}

const OPEN_NO_HOST: TunnelState = {
  ...Tunnel.freshTunnelState,
  requestedRunning: true,
  running: true,
  publicHost: null,
}

const CLOSED: TunnelState = {
  ...Tunnel.freshTunnelState,
  requestedRunning: false,
  running: false,
  publicHost: null,
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TunnelExplainer', () => {
  it('renders the open copy with the public host emphasized when running with a host', () => {
    render(<TunnelExplainer state={OPEN_WITH_HOST} />)

    expect(screen.getByText(/Apps and people you've authorized/)).toBeTruthy()
    // The host renders inside a <strong>, separate from surrounding text.
    const host = screen.getByText('ruth.wildflowerhealth.io')
    expect(host.tagName.toLowerCase()).toBe('strong')
  })

  it('renders the open copy without the "at {host}" clause when no host is set', () => {
    render(<TunnelExplainer state={OPEN_NO_HOST} />)

    expect(
      screen.getByText(/Apps and people you've authorized can access your device\./)
    ).toBeTruthy()
    // No <strong> emphasis is rendered when there is no host to surface.
    expect(document.querySelector('strong')).toBeNull()
  })

  it('renders the closed copy when neither requestedRunning nor running is true', () => {
    render(<TunnelExplainer state={CLOSED} />)

    expect(
      screen.getByText(/By default, your personal health record is only accessible on this device/)
    ).toBeTruthy()
  })

  // Errs toward "open" during transitions so the user is not told
  // "only on this device" while a public host is still reachable.
  it('renders the open copy when running is true even with requestedRunning false (stopping)', () => {
    const stopping: TunnelState = {
      ...OPEN_WITH_HOST,
      requestedRunning: false,
      running: true,
    }
    render(<TunnelExplainer state={stopping} />)

    expect(screen.getByText(/Apps and people you've authorized/)).toBeTruthy()
  })

  it('renders the open copy when requestedRunning is true even before running flips (starting)', () => {
    const starting: TunnelState = {
      ...OPEN_WITH_HOST,
      requestedRunning: true,
      running: false,
    }
    render(<TunnelExplainer state={starting} />)

    expect(screen.getByText(/Apps and people you've authorized/)).toBeTruthy()
  })
})
