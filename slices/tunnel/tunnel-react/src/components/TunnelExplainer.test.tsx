import { render, screen } from '@testing-library/react'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import type { TunnelState } from '../queries/index.ts'
import { TunnelExplainer } from './TunnelExplainer.tsx'

const DIALING: TunnelState = {
  ...Tunnel.freshTunnelState,
  publicHost: 'ruth.wildflowerhealth.io',
}

const OFF: TunnelState = {
  ...Tunnel.freshTunnelState,
  status: 'off',
  running: false,
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TunnelExplainer', () => {
  it('renders the open copy with the public host emphasized while the tunnel runs', () => {
    render(<TunnelExplainer state={DIALING} />)

    expect(screen.getByText(/Apps and people you've authorized/)).toBeTruthy()
    // The host renders inside a <strong>, separate from surrounding text.
    const host = screen.getByText('ruth.wildflowerhealth.io')
    expect(host.tagName.toLowerCase()).toBe('strong')
  })

  it('renders the open copy while the tunnel is unreachable and retrying', () => {
    render(<TunnelExplainer state={{ ...DIALING, status: 'unreachable', error: 'refused' }} />)

    expect(screen.getByText(/Apps and people you've authorized/)).toBeTruthy()
  })

  it('renders the closed copy when the server has no tunnel', () => {
    render(<TunnelExplainer state={OFF} />)

    expect(screen.getByText(/This server has no tunnel/)).toBeTruthy()
  })
})
