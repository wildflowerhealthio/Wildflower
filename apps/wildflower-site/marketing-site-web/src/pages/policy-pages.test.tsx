import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { Deletion } from './deletion.tsx'
import { PrivacyPolicy } from './privacy-policy.tsx'

afterEach(() => {
  cleanup()
})

describe('PrivacyPolicy', () => {
  it('should title the page and link to the deletion page', () => {
    // Arrange / Act
    render(<PrivacyPolicy />)

    // Assert
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Privacy policy')
    expect(screen.getByRole('link', { name: 'Deleting your data' }).getAttribute('href')).toBe(
      '../deletion/'
    )
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
