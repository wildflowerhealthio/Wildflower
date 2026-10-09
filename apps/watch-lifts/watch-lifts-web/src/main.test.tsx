import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

/**
 * The entry module's URL work, which must happen before anything reads the URL,
 * and the page it mounts from that URL. `main.tsx` mounts React only when
 * `#root` exists, so a test that asserts only on the address bar leaves the
 * document empty.
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
    stubMatchMedia()
  })

  it('should restore a 404 redirect into the address bar, keeping the weights and return_to', async () => {
    await importEntry(
      '/watch-lifts/?redirect=/watch-lifts/index.html&weights=%7B%7D&return_to=pebblejs%3A%2F%2Fclose%23'
    )

    const params = new URLSearchParams(window.location.search)
    expect(window.location.pathname).toBe('/watch-lifts/index.html')
    expect(params.has('redirect')).toBe(false)
    expect(params.get('weights')).toBe('{}')
    expect(params.get('return_to')).toBe('pebblejs://close#')
  })

  it('should mount the page with the weights the URL carries', async () => {
    document.body.innerHTML = '<div id="root"></div>'

    await importEntry(
      `/watch-lifts/?weights=${encodeURIComponent('{"weights":[[1,2,3,4,5],[6,7,8,9,10]]}')}`
    )

    const deadlift = await screen.findByRole<HTMLInputElement>('textbox', {
      name: "Chloe's Deadlift weight, lbs",
    })
    expect(deadlift.value).toBe('10')
  })
})
