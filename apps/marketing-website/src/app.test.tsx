import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { App } from './app.tsx'

afterEach(() => {
  cleanup()
})

describe('App', () => {
  it('should render the shared site header with a #top anchor', () => {
    // Arrange / Act
    render(<App />)

    // Assert — the header carries id="top" for the brand link's scroll target.
    expect(document.querySelector('#top')).not.toBeNull()
  })

  it('should render the shared site footer with fragment-only nav hrefs', () => {
    // Arrange / Act
    render(<App />)

    // Assert — on the marketing site, nav links are in-page anchors, not
    // absolute URLs to another section.
    const footerLinks = screen.getAllByRole('link')
    const fragmentHrefs = footerLinks
      .map((link) => link.getAttribute('href'))
      .filter((href) => href?.startsWith('#'))

    expect(fragmentHrefs).toContain('#how')
    expect(fragmentHrefs).toContain('#privacy')
    expect(fragmentHrefs).toContain('#invite')
  })
})
