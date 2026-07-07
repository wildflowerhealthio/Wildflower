import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { AppAvatar } from './app-avatar.tsx'

/**
 * `AppAvatar` shows the app's favicon — scooped from the redirect URI's origin —
 * over a letter-monogram fallback. The behaviour worth pinning is the two paths
 * into the monogram: an unparseable redirect URI (no origin to scoop from) and a
 * favicon that fails to load (404 / CSP block / transport error).
 */

afterEach(() => {
  cleanup()
})

describe('AppAvatar', () => {
  test('renders the favicon from the redirect URI origin, ignoring its path', () => {
    render(<AppAvatar name="Fitbit Sync" redirectUri="https://app.example/oauth/cb?x=1" />)

    const img = screen.getByRole('img', { name: 'Fitbit Sync logo' })
    expect(img.getAttribute('src')).toBe('https://app.example/favicon.ico')
  })

  test('falls back to the name monogram when the redirect URI will not parse', () => {
    render(<AppAvatar name="fitbit" redirectUri="not a url" />)

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('F')).toBeDefined()
  })

  test('falls back to the monogram when the favicon fails to load', () => {
    render(<AppAvatar name="Zed" redirectUri="https://app.example/cb" />)

    fireEvent.error(screen.getByRole('img', { name: 'Zed logo' }))

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Z')).toBeDefined()
  })
})
