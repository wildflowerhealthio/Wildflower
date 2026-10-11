import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { ConsumerHealthData } from './consumer-health-data.tsx'
import { Deletion } from './deletion.tsx'
import { PrivacyPolicy } from './privacy-policy.tsx'
import { Terms } from './terms.tsx'

afterEach(() => {
  cleanup()
})

describe('PrivacyPolicy', () => {
  it('should title the page and link to the deletion page', () => {
    // Arrange / Act
    render(<PrivacyPolicy />)

    // Assert
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Privacy policy')
    // Within the prose: the shared footer links to the same page by its
    // absolute URL.
    const main = within(screen.getByRole('main'))
    expect(main.getByRole('link', { name: 'Deleting your data' }).getAttribute('href')).toBe(
      '../deletion/'
    )
  })

  it('should carry the sections particular laws ask for, and the medical disclaimer', () => {
    // Arrange / Act
    render(<PrivacyPolicy />)

    // Assert — the GDPR wants the controller, bases, transfers and rights; a
    // health app wants to say it is not medical advice. The consumer health
    // data policy is its own page, linked from here.
    expect(
      screen.getByRole('link', { name: 'consumer health data privacy policy' }).getAttribute('href')
    ).toBe('../consumer-health-data/')
    expect(
      screen.getByRole('heading', { name: 'If you are in the EU, the UK or Switzerland' })
    ).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Not medical advice' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'If something goes wrong' })).toBeDefined()
    expect(screen.getAllByText(/90 days/).length).toBeGreaterThan(0)
  })
})

describe('ConsumerHealthData', () => {
  it('should title the page and carry what the state health data laws ask a policy to say', () => {
    // Arrange / Act
    render(<ConsumerHealthData />)

    // Assert — Washington's My Health My Data Act and Nevada's consumer health
    // data law each want a separate policy: what is collected and why, its
    // sources, who it is shared with, the rights, cross-site tracking and how
    // changes are announced.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Consumer health data privacy policy'
    )
    for (const title of [
      'Why this page exists',
      'What I may collect, and why',
      'Where it comes from',
      'Who it is shared with',
      'Tracking across other sites',
      'Your rights',
      'Changes',
    ]) {
      expect(screen.getByRole('heading', { name: title })).toBeDefined()
    }
    const main = within(screen.getByRole('main'))
    expect(main.getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe(
      '../privacy-policy/'
    )
  })
})

describe('Terms', () => {
  it('should title the page and link to the privacy policy and the deletion page', () => {
    // Arrange / Act
    render(<Terms />)

    // Assert
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Terms of use')
    expect(screen.getByRole('link', { name: 'privacy policy' }).getAttribute('href')).toBe(
      '../privacy-policy/'
    )
    expect(screen.getByRole('link', { name: 'deletion page' }).getAttribute('href')).toBe(
      '../deletion/'
    )
    for (const title of ['Not medical advice', 'No warranty', 'Limitation of liability']) {
      expect(screen.getByRole('heading', { name: title })).toBeDefined()
    }
  })
})

describe('Deletion', () => {
  it('should title the page, name the app, and link back to the privacy policy', () => {
    // Arrange / Act
    render(<Deletion />)

    // Assert — Google Play requires the deletion page to name the app it
    // covers.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Deleting your data')
    expect(screen.getAllByText(/Wildflower Host/).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'privacy policy' }).getAttribute('href')).toBe(
      '../privacy-policy/'
    )
  })
})
