import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { App } from './app.tsx'

beforeEach(() => {
  // jsdom has no `matchMedia`; report reduced motion so the stats count-up
  // renders its final values synchronously instead of animating across
  // frames while assertions run.
  vi.stubGlobal('matchMedia', (query: string): Pick<MediaQueryList, 'matches' | 'media'> => ({
    matches: true,
    media: query,
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('should render the site title as the only h1, linking back to #top', () => {
    // Arrange / Act
    render(<App />)

    // Assert — the wordmark is the page's only h1 by design, even though the
    // hero's "Hi, I'm Ruth." is visually larger.
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    const title = headings[0]
    expect(title.textContent).toBe('Wildflower Health Project')
    expect(within(title).getByRole('link').getAttribute('href')).toBe('#top')
  })

  it('should link the header nav to the four app routes', () => {
    // Arrange / Act
    render(<App />)

    // Assert — every "call to action" on the page is a link into an app;
    // the header carries all four routes.
    const nav = screen.getByRole('navigation', { name: 'Apps' })
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
    expect(hrefs).toStrictEqual([
      '/medications-app',
      '/importer-app',
      '/web-trace-app',
      '/wildflower-server-docs',
    ])
  })

  it('should render the stats grid at its final values with aligned plus padding', () => {
    // Arrange / Act
    render(<App />)

    // Assert — under reduced motion the numbers render at their final
    // values. Non-"+" cells end with an invisible "+" that reserves the plus
    // sign's width so digits right-align against the "10+" rows.
    const labResultsNumber = screen.getByText('lab results').previousElementSibling
    expect(labResultsNumber?.textContent).toBe('213+')
    expect(screen.getAllByText('10+')).toHaveLength(2)
    const medicationsNumber = screen.getByText('prescription medications').previousElementSibling
    expect(medicationsNumber?.textContent).toBe('10+')
  })

  it('should render every section anchor in page order', () => {
    // Arrange / Act
    const { container } = render(<App />)

    // Assert — the in-page anchor targets the app chrome links back to.
    for (const id of ['top', 'built', 'try', 'asks', 'developers', 'note']) {
      expect(container.querySelector(`#${id}`), `#${id}`).not.toBeNull()
    }
  })

  it('should render launcher links into the apps, and none for the Synthesized Health Viewer', () => {
    // Arrange / Act
    render(<App />)

    // Assert
    expect(
      screen.getByRole('link', { name: /Open the Medication Viewer/ }).getAttribute('href')
    ).toBe('/medications-app')
    expect(
      screen.getByRole('link', { name: /Read the Wildflower server docs/ }).getAttribute('href')
    ).toBe('/wildflower-server-docs')
    expect(screen.getByRole('link', { name: /Open the Importer/ }).getAttribute('href')).toBe(
      '/importer-app'
    )
    expect(
      screen.getByRole('link', { name: /Open the Web Trace Viewer/ }).getAttribute('href')
    ).toBe('/web-trace-app')
    // No public route yet — intentionally no launcher.
    expect(screen.getByText('Synthesized Health Viewer')).toBeDefined()
    expect(screen.queryByRole('link', { name: /Synthesized/ })).toBeNull()
  })

  it('should end on the contact line and the mono stamp', () => {
    // Arrange / Act
    render(<App />)

    // Assert
    const footer = within(screen.getByRole('contentinfo'))
    expect(footer.getByRole('link', { name: 'ruthmarks151@gmail.com' }).getAttribute('href')).toBe(
      'mailto:ruthmarks151@gmail.com'
    )
    expect(footer.getByText(/Wildflower Health Project · Ruth Marks · 2026/)).toBeDefined()
  })
})
