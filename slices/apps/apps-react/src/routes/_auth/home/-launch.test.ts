import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import type { AppEntry } from '../../../queries.ts'
import { launchApp } from './-launch.ts'

// A minimal `AppEntry` — `launchApp` reads only `id`, so the other fields are
// the lightest valid wire shape. (The list response intentionally omits `url`
// — the launch endpoint resolves it per request.)
const app: AppEntry = {
  id: 'pt-browser',
  enabled: true,
  name: 'Patient Browser',
  requiresTunnel: false,
}

// Some launches need a hidden form to submit to; build one fresh per test
// so action mutations don't leak between cases.
const makeForm = (): HTMLFormElement => document.createElement('form')

const restoreFetch = (): void => {
  vi.unstubAllGlobals()
}

describe('launchApp', () => {
  // The fetch arm logs through `console.error` on the unhappy paths; spy on
  // it so the assertions can read what was logged and the test output stays
  // quiet.
  let consoleError: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    restoreFetch()
    consoleError.mockRestore()
  })

  describe('Tauri arm (apiBaseUrl set)', () => {
    test('POSTs to ${apiBaseUrl}/apps/{id} with redirect:manual', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchMock)

      await launchApp(
        {
          apiBaseUrl: 'http://127.0.0.1:8080',
          pageOrigin: 'tauri://localhost',
          form: makeForm(),
        },
        app
      )

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('http://127.0.0.1:8080/apps/pt-browser')
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
    })

    test('strips a trailing slash on apiBaseUrl so the URL has exactly one /apps/', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchMock)

      await launchApp(
        { apiBaseUrl: 'http://127.0.0.1:8080/', pageOrigin: 'tauri://localhost', form: null },
        app
      )

      expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8080/apps/pt-browser')
    })

    test('encodes a path-unsafe id', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchMock)

      await launchApp(
        { apiBaseUrl: 'http://127.0.0.1:8080', pageOrigin: 'tauri://localhost', form: null },
        { ...app, id: 'has spaces/and-slashes' }
      )

      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://127.0.0.1:8080/apps/has%20spaces%2Fand-slashes'
      )
    })

    test('does NOT submit the form when apiBaseUrl is set', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchMock)
      const form = makeForm()
      const submit = vi.spyOn(form, 'submit').mockImplementation(() => {})

      await launchApp(
        { apiBaseUrl: 'http://127.0.0.1:8080', pageOrigin: 'tauri://localhost', form },
        app
      )

      expect(submit).not.toHaveBeenCalled()
    })

    test('logs an unexpected status (non-2xx) instead of silently swallowing it', async () => {
      // A 404 (just-deleted/disabled app) resolves the fetch rather than
      // rejecting, so a `.catch`-only path would miss it — `!response.ok`
      // surfaces it.
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('not found', { status: 404 }))
      vi.stubGlobal('fetch', fetchMock)

      await launchApp(
        { apiBaseUrl: 'http://127.0.0.1:8080', pageOrigin: 'tauri://localhost', form: null },
        app
      )

      // Asserts the log carries the status and response `type` (the latter
      // distinguishes the opaque-redirect case; here a normal `default`).
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('unexpected status'),
        404,
        expect.any(String)
      )
    })

    test('logs a fetch rejection', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
      vi.stubGlobal('fetch', fetchMock)

      await launchApp(
        { apiBaseUrl: 'http://127.0.0.1:8080', pageOrigin: 'tauri://localhost', form: null },
        app
      )

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('launch fetch failed'),
        expect.any(Error)
      )
    })

    test('does not log on a 204 (the expected happy path)', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchMock)

      await launchApp(
        { apiBaseUrl: 'http://127.0.0.1:8080', pageOrigin: 'tauri://localhost', form: null },
        app
      )

      expect(consoleError).not.toHaveBeenCalled()
    })
  })

  describe('web arm (apiBaseUrl unset)', () => {
    test('submits the hidden form to ${pageOrigin}/apps/{id}', async () => {
      const fetchMock = vi.fn<typeof fetch>()
      vi.stubGlobal('fetch', fetchMock)
      const form = makeForm()
      const submit = vi.spyOn(form, 'submit').mockImplementation(() => {})

      await launchApp({ apiBaseUrl: undefined, pageOrigin: 'https://app.example.com', form }, app)

      expect(submit).toHaveBeenCalledTimes(1)
      expect(form.action).toBe('https://app.example.com/apps/pt-browser')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    test('strips a trailing slash on pageOrigin', async () => {
      const form = makeForm()
      const submit = vi.spyOn(form, 'submit').mockImplementation(() => {})

      await launchApp({ apiBaseUrl: undefined, pageOrigin: 'https://app.example.com/', form }, app)

      expect(submit).toHaveBeenCalledTimes(1)
      expect(form.action).toBe('https://app.example.com/apps/pt-browser')
    })

    test('is a no-op when the form ref is null (component not mounted yet)', async () => {
      const fetchMock = vi.fn<typeof fetch>()
      vi.stubGlobal('fetch', fetchMock)

      await launchApp(
        { apiBaseUrl: undefined, pageOrigin: 'https://app.example.com', form: null },
        app
      )

      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
