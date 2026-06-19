import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { Chip } from './chip.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Chip', () => {
  it('renders its label children inside a single span', () => {
    render(<Chip>Advanced</Chip>)

    const chip = screen.getByText('Advanced')
    expect(chip.tagName).toBe('SPAN')
  })

  it('forwards a consumer className alongside the chip class', () => {
    render(<Chip className="extra-margin">Beta</Chip>)

    const chip = screen.getByText('Beta')
    // Chip's intrinsic class is CSS-modules-hashed; check by substring.
    expect(chip.className).toMatch(/chip/)
    expect(chip.classList.contains('extra-margin')).toBe(true)
  })

  it('preserves the underlying label text (not the CSS-transformed uppercase) for AT', () => {
    // `text-transform: uppercase` is a paint-time transform; screen
    // readers read the underlying string, so consumers can pass
    // sentence-case labels and AT users hear them naturally.
    render(<Chip>Advanced</Chip>)

    expect(screen.getByText('Advanced').textContent).toBe('Advanced')
  })
})
