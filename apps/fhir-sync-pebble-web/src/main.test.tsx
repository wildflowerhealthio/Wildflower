import { ReturnTargetStore } from 'fhir-sync-pebble-core'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

/**
 * The entry module's URL work, which must happen before anything reads the URL
 * or navigates away. The assertions are on the address bar and session storage
 * after import — `main.tsx` mounts React only when `#root` exists, and these
 * tests deliberately leave the document empty.
 */
const importEntry = async (url: string): Promise<void> => {
  window.history.replaceState(null, '', url)
  await import('./main.tsx')
}

/**
 * jsdom ships no `matchMedia`, which the entry's OS colour-scheme listener
 * calls. Stubbed as "light, never changes" so importing the entry gets past it.
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
    vi.resetModules()
    document.body.innerHTML = ''
    window.sessionStorage.clear()
    stubMatchMedia()
  })

  it('should restore a 404 redirect into the address bar, dropping the redirect parameter', async () => {
    await importEntry('/fhir-sync-pebble/?redirect=/settings&iss=https%3A%2F%2Fexample.com')

    expect(window.location.pathname).toBe('/fhir-sync-pebble/settings')
    expect(new URLSearchParams(window.location.search).has('redirect')).toBe(false)
    expect(new URLSearchParams(window.location.search).get('iss')).toBe('https://example.com')
  })

  it("should keep the Pebble app's return_to for after the SMART login", async () => {
    await importEntry('/fhir-sync-pebble/?return_to=pebblejs%3A%2F%2Fclose%23')

    expect(window.sessionStorage.getItem(ReturnTargetStore.STORAGE_KEY)).toBe('pebblejs://close#')
  })
})
