import { afterEach, describe, expect, test } from 'vite-plus/test'

import { applyColorScheme } from './apply-color-scheme.ts'

describe('applyColorScheme', () => {
  afterEach(() => {
    delete document.documentElement.dataset.colorScheme
  })

  test('writes the scheme as the data-color-scheme attribute on the root element', () => {
    applyColorScheme('dark')
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe('dark')
  })

  test('re-applying overwrites the previous scheme rather than accumulating', () => {
    applyColorScheme('dark')
    applyColorScheme('light')
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe('light')
  })
})
