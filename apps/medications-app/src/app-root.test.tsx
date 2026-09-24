import { cleanup, render, screen } from '@testing-library/react'
import { APP_DESCRIPTIONS } from 'branding-core'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { AppRoot } from './app-root.tsx'

// The shell's own behaviour (the two branches, the latch, the shared client,
// the launch-failure banner) is covered by `smart-app-react`'s
// `smart-app-root.test.tsx`; this pins only that the app mounts it as itself.
vi.mock('./app.tsx', () => ({
  App: () => <div data-testid="app" />,
}))

afterEach(() => {
  cleanup()
})

describe('AppRoot', () => {
  it('should mount the shell as the Medication Viewer when not launched', () => {
    // Arrange / Act
    render(<AppRoot launched={false} />)

    // Assert — the landing introduces this app, not another
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      APP_DESCRIPTIONS.medications.name
    )
    expect(screen.queryByTestId('app')).toBeNull()
  })
})
