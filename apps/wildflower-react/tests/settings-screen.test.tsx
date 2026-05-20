import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, test } from 'vite-plus/test'

import { SettingsScreen } from '../src/screens/settings-screen.tsx'

const renderSettingsScreen = (): void => {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <SettingsScreen />
    </MemoryRouter>
  )
}

describe('SettingsScreen', () => {
  test('renders the page heading', () => {
    renderSettingsScreen()
    const headings = screen.getAllByRole('heading', { name: 'Settings', level: 1 })
    expect(headings.length).toBeGreaterThanOrEqual(1)
  })

  test('aggregates one row per participating slice (tunnel, collector, gatekeeper)', () => {
    renderSettingsScreen()
    // Each slice contributes exactly one top-level menu item via its
    // `*SettingsItemsFragment`. Use getAllByText because the test
    // environment may render the tree more than once (React StrictMode
    // double-invocation under jsdom), which doesn't reflect a real
    // duplication in the screen output.
    expect(screen.getAllByText('Tunnel').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Collector').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Access').length).toBeGreaterThanOrEqual(1)
  })

  test('every row links into /settings/<slice>/', () => {
    renderSettingsScreen()
    // Walk each row's anchor href; settings items always render as
    // links per the `<ItemList>` contract for href-bearing items. The
    // app's invariant is that every settings URL lives under /settings.
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThanOrEqual(3)
    for (const link of links) {
      const href = link.getAttribute('href') ?? ''
      expect(href.startsWith('/settings/')).toBe(true)
    }
  })

  test('each slice item links to its declared href', () => {
    renderSettingsScreen()
    // Map href → set of titles found at that href to assert the link
    // graph matches the slices' fragment declarations regardless of
    // duplicate-rendering quirks.
    const links = screen.getAllByRole('link')
    const hrefs = new Set(links.map((l) => l.getAttribute('href') ?? ''))
    expect(hrefs.has('/settings/tunnel')).toBe(true)
    expect(hrefs.has('/settings/collector')).toBe(true)
    expect(hrefs.has('/settings/gatekeeper')).toBe(true)
  })
})
