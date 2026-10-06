import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { writeToClipboard } from './write-to-clipboard.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stubs `navigator` with a clipboard whose `writeText` runs `writeText`. */
function stubClipboard(writeText: (text: string) => Promise<void>): void {
  vi.stubGlobal('navigator', { clipboard: { writeText } })
}

describe('writeToClipboard', () => {
  it('should write the text to the clipboard', async () => {
    const written: string[] = []
    stubClipboard((text) => {
      written.push(text)
      return Promise.resolve()
    })

    await writeToClipboard('203.0.113.9')

    expect(written).toEqual(['203.0.113.9'])
  })

  it('should resolve when the clipboard refuses the write', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')))

    await expect(writeToClipboard('203.0.113.9')).resolves.toBeUndefined()
  })

  it('should resolve when the page has no clipboard', async () => {
    vi.stubGlobal('navigator', {})

    await expect(writeToClipboard('203.0.113.9')).resolves.toBeUndefined()
  })
})
