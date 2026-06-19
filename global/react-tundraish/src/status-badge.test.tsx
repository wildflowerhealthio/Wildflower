import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { StatusBadge } from './status-badge.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('StatusBadge', () => {
  it('always exposes role="status" so AT users get an announcement', () => {
    // Arrange
    // Act
    render(<StatusBadge>Active</StatusBadge>)

    // Assert
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('omits the accent class for neutral tone (no empty-string sentinel)', () => {
    // Arrange
    // Act
    render(<StatusBadge tone="neutral">Idle</StatusBadge>)

    // Assert
    const badge = screen.getByRole('status')
    expect(Array.from(badge.classList)).not.toContain('')
    expect(badge.className).toMatch(/^status-badge\s*$/)
  })

  it('applies the tone-specific accent class for non-neutral tones', () => {
    // Arrange
    // Act
    render(<StatusBadge tone="warning">Caution</StatusBadge>)

    // Assert
    expect(screen.getByRole('status').classList.contains('accent-yellow')).toBe(true)
  })

  it.each([
    ['success', 'Success: '],
    ['warning', 'Warning: '],
    ['danger', 'Error: '],
  ] as const)(
    'prepends an sr-only %s label so tone is not conveyed only by color',
    (tone, label) => {
      // Arrange
      // Act
      render(<StatusBadge tone={tone}>Message</StatusBadge>)

      // Assert
      const badge = screen.getByRole('status')
      expect(badge.textContent).toContain(label)
      expect(badge.querySelector('.sr-only')?.textContent).toBe(label)
    }
  )

  it('does not add an sr-only label for neutral or info tones', () => {
    // Arrange
    // Act
    const { rerender } = render(<StatusBadge tone="neutral">Idle</StatusBadge>)

    // Assert
    expect(screen.getByRole('status').querySelector('.sr-only')).toBeNull()

    // Arrange
    // Act
    rerender(<StatusBadge tone="info">Info</StatusBadge>)

    // Assert
    expect(screen.getByRole('status').querySelector('.sr-only')).toBeNull()
  })

  it('adds the pulse class only when pulse is true', () => {
    const { rerender } = render(
      <StatusBadge tone="success" pulse>
        Online
      </StatusBadge>
    )
    expect(screen.getByRole('status').classList.contains('pulse')).toBe(true)

    rerender(<StatusBadge tone="success">Online</StatusBadge>)
    expect(screen.getByRole('status').classList.contains('pulse')).toBe(false)
  })
})
