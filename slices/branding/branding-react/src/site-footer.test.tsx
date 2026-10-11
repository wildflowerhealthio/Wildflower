import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { SiteFooter } from './site-footer.tsx'

afterEach(() => {
  cleanup()
})

describe('SiteFooter', () => {
  it('should render the "not a company" paragraph', () => {
    // Arrange / Act
    render(<SiteFooter />)

    // Assert
    expect(screen.getByText(/open source series of connected experiments/)).toBeDefined()
  })

  it('should end on the contact line and the mono stamp', () => {
    // Arrange / Act
    render(<SiteFooter />)

    // Assert
    expect(screen.getByRole('link', { name: 'ruthmarks151@gmail.com' }).getAttribute('href')).toBe(
      'mailto:ruthmarks151@gmail.com'
    )
    const year = new Date().getFullYear()
    expect(screen.getByText(`Wildflower Health Project · Ruth Marks · ${year}`)).toBeDefined()
  })

  it('should link to the privacy policy, the terms of use and the deletion page on the canonical site', () => {
    // Arrange / Act
    render(<SiteFooter />)

    // Assert — the app stores require the apps to link to these pages, and
    // every app's landing page ends in this footer.
    const policies = screen.getByRole('list', { name: 'Policies' })
    expect(
      within(policies).getByRole('link', { name: 'Privacy policy' }).getAttribute('href')
    ).toBe('https://wildflowerhealth.io/privacy-policy/')
    expect(within(policies).getByRole('link', { name: 'Terms of use' }).getAttribute('href')).toBe(
      'https://wildflowerhealth.io/terms/'
    )
    expect(
      within(policies).getByRole('link', { name: 'Deleting your data' }).getAttribute('href')
    ).toBe('https://wildflowerhealth.io/deletion/')
  })

  it('should expose the #note anchor target the homepage links to', () => {
    // Arrange / Act
    const { container } = render(<SiteFooter />)

    // Assert
    expect(container.querySelector('#note')).not.toBeNull()
  })
})
