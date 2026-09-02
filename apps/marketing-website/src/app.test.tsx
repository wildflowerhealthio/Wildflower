import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { App } from './app.tsx'

afterEach(() => {
  cleanup()
})

describe('App', () => {
  it('should render the shared site header as the #top anchor with in-page links', () => {
    // Arrange / Act
    render(<App />)

    // Assert — the header landmark carries id="top" so the brand link scrolls
    // back to it, and every link in it is an in-page anchor (the marketing
    // `NavContext`), not an absolute URL back to this same page.
    const header = screen.getByRole('banner')
    expect(header.id).toBe('top')
    expect(
      within(header).getByRole('link', { name: 'Wildflower, home' }).getAttribute('href')
    ).toBe('#top')
    const hrefs = within(header)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
    for (const href of hrefs) {
      expect(href).toMatch(/^#/)
    }
    expect(hrefs).toEqual(expect.arrayContaining(['#how', '#privacy', '#invite']))
  })

  it('should render the shared site footer with fragment-only nav hrefs', () => {
    // Arrange / Act
    render(<App />)

    // Assert — scoped to the footer landmark so the header's identical nav
    // targets cannot satisfy this on their own. On the marketing site, nav
    // links are in-page anchors, not absolute URLs to another section.
    const footer = within(screen.getByRole('contentinfo'))
    const fragmentHrefs = footer
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href) => href?.startsWith('#'))

    expect(fragmentHrefs).toContain('#how')
    expect(fragmentHrefs).toContain('#privacy')
    expect(fragmentHrefs).toContain('#invite')
  })
})
