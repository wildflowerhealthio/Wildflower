import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { TunnelExplainer } from './TunnelExplainer.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TunnelExplainer', () => {
  it('explains who can reach the device through the tunnel', () => {
    render(<TunnelExplainer />)

    expect(screen.getByText(/Apps and people you've authorized/)).toBeTruthy()
  })
})
