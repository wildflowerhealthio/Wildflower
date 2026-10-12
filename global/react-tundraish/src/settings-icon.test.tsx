import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { SettingsIcon } from './settings-icon.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SettingsIcon', () => {
  it('is hidden from assistive technology, leaving the label to its control', () => {
    // Arrange / Act
    const { container } = render(<SettingsIcon />)

    // Assert
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('paints in the current colour, so it takes its control’s colour', () => {
    // Arrange / Act
    const { container } = render(<SettingsIcon />)

    // Assert
    expect(container.querySelector('svg')?.getAttribute('fill')).toBe('currentColor')
  })
})
