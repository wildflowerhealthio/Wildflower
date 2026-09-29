import { DEFAULT_DATA_SET_URL } from 'synthetic-data-react'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { rememberedDataSetUrl } from './data-set-url-memory.ts'

/**
 * The entry module's half of the GitHub Pages 404 contract: it must complete a
 * `?redirect=` landing before anything reads the URL. It also keeps a bare
 * visit's `?dataSet=` for after the SMART redirect. The assertions are on the
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
    window.sessionStorage.clear()
    vi.resetModules()
    stubMatchMedia()
  })

  it('should restore a 404 redirect into the address bar, dropping the redirect parameter', async () => {
    await importEntry('/synthetic-data-app/?redirect=/history&iss=https%3A%2F%2Fexample.com')

    expect(window.location.pathname).toBe('/synthetic-data-app/history')
    expect(new URLSearchParams(window.location.search).has('redirect')).toBe(false)
    expect(new URLSearchParams(window.location.search).get('iss')).toBe('https://example.com')
  })

  it('should keep the ?dataSet= a visit names as the data set to read', async () => {
    await importEntry('/synthetic-data-app/?dataSet=http%3A%2F%2Flocalhost%3A8000%2F')

    expect(rememberedDataSetUrl(window.sessionStorage)).toBe('http://localhost:8000/')
  })

  it('should leave the published data set in place on a visit without ?dataSet=', async () => {
    await importEntry('/synthetic-data-app/')

    expect(rememberedDataSetUrl(window.sessionStorage)).toBe(DEFAULT_DATA_SET_URL)
  })
})
