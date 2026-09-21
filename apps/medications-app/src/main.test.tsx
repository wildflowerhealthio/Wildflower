import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

/**
 * The entry module's half of the GitHub Pages 404 contract: it must complete a
 * `?redirect=` landing before anything reads the URL. The assertions are on the
 * address bar after import — `main.tsx` mounts React only when `#root` exists,
 * and these tests deliberately leave the document empty, so importing it runs
 * the restoration and nothing else.
 */
const importEntry = async (url: string): Promise<void> => {
  window.history.replaceState(null, '', url)
  await import('./main.tsx')
}

/**
 * jsdom ships no `matchMedia`, which the entry's OS colour-scheme listener
 * calls one statement after the restoration. Stubbed as "light, never changes"
 * so importing the entry gets past it.
 */
const stubMatchMedia = (): void => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  }))
}

describe('main.tsx', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    stubMatchMedia()
  })

  it('should restore a 404 redirect into the address bar, dropping the redirect parameter', async () => {
    await importEntry('/medications-app/?redirect=/history&iss=https%3A%2F%2Fexample.com')

    expect(window.location.pathname).toBe('/medications-app/history')
    expect(new URLSearchParams(window.location.search).has('redirect')).toBe(false)
    expect(new URLSearchParams(window.location.search).get('iss')).toBe('https://example.com')
  })
})
