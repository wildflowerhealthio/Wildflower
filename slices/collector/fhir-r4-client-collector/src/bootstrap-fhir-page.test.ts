// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers (`expect.stringContaining`, `expect.objectContaining`) are typed as `any`; composing them inside other matchers is the intended idiom

import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { bootstrapFhirPage, buildFhirBootstrapHtml } from './bootstrap-fhir-page.ts'

const originalFetch = window.fetch
const originalRnwv = (window as Window & { ReactNativeWebView?: { postMessage(s: string): void } })
  .ReactNativeWebView

interface DomRefs {
  h2: HTMLElement
  button: HTMLElement
  log: HTMLElement
}

const setupDom = (): DomRefs => {
  document.body.innerHTML = `
    <button id="fetch-observations"></button>
    <h2 id="h2">Loading...</h2>
    <pre id="log"></pre>
  `
  return {
    h2: document.getElementById('h2')!,
    button: document.getElementById('fetch-observations')!,
    log: document.getElementById('log')!,
  }
}

const installRnwv = (postMessage: (s: string) => void): void => {
  ;(
    window as Window & { ReactNativeWebView?: { postMessage(s: string): void } }
  ).ReactNativeWebView = { postMessage }
}

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.useRealTimers()
  window.fetch = originalFetch
  ;(
    window as Window & { ReactNativeWebView?: { postMessage(s: string): void } }
  ).ReactNativeWebView = originalRnwv
})

describe('bootstrapFhirPage', () => {
  it('puts "Fetching" into #h2 immediately when the timer fires, then the patient body once fetch resolves', async () => {
    const { h2 } = setupDom()
    window.fetch = vi.fn().mockResolvedValue(new Response('{"resourceType":"Patient","id":"42"}'))

    bootstrapFhirPage({
      patientUrl: 'https://e.test/Patient/42',
      observationUrl: 'https://e.test/Observation',
    })
    expect(h2.textContent).toBe('Loading...')

    // Sync `advanceTimersByTime` fires the 500ms timer (the body writes
    // 'Fetching' and kicks off the fetch) without also draining the
    // microtask queue — that's `advanceTimersByTimeAsync`'s extra step,
    // and it would resolve the mocked fetch before we can observe the
    // intermediate state.
    vi.advanceTimersByTime(500)
    expect(h2.textContent).toBe('Fetching')
    // Now drain the .then(text => …) microtasks to land the body.
    await vi.runAllTimersAsync()
    expect(h2.textContent).toBe('{"resourceType":"Patient","id":"42"}')
  })

  it('writes the fetch error message into #h2 and #log on failure', async () => {
    const { h2, log } = setupDom()
    window.fetch = vi.fn().mockRejectedValue(new Error('network down'))

    bootstrapFhirPage({
      patientUrl: 'https://e.test/Patient/42',
      observationUrl: 'https://e.test/Observation',
    })

    await vi.advanceTimersByTimeAsync(500)
    await vi.runAllTimersAsync()
    expect(h2.textContent).toContain('network down')
    expect(log.textContent).toContain('network down')
  })

  it('posts the patient-fetch result through the ReactNativeWebView bridge as a Log message', async () => {
    setupDom()
    window.fetch = vi.fn().mockResolvedValue(new Response('{"resourceType":"Patient","id":"42"}'))
    const postMessage = vi.fn<(s: string) => void>()
    installRnwv(postMessage)

    bootstrapFhirPage({
      patientUrl: 'https://e.test/Patient/42',
      observationUrl: 'https://e.test/Observation',
    })

    await vi.advanceTimersByTimeAsync(500)
    await vi.runAllTimersAsync()

    const payloads = postMessage.mock.calls.map(([s]) => JSON.parse(s) as unknown)
    expect(payloads).toContainEqual(
      expect.objectContaining({ _tag: 'Log', log: expect.stringContaining('Patient fetched') })
    )
  })

  it('wires the fetch-observations button to fetch and post a Log on click', async () => {
    const { button, log } = setupDom()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('[]', { headers: { 'content-type': 'application/json' } }))
    window.fetch = fetchMock
    const postMessage = vi.fn<(s: string) => void>()
    installRnwv(postMessage)

    bootstrapFhirPage({
      patientUrl: 'https://e.test/Patient/42',
      observationUrl: 'https://e.test/Observation',
    })

    button.click()
    // Allow the promise chain to settle
    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledWith('https://e.test/Observation')
    // Click-side activity is mirrored into #log and the bridge.
    expect(log.textContent).toContain('Fetching observations')
    expect(log.textContent).toContain('Observations fetched')
    const payloads = postMessage.mock.calls.map(([s]) => JSON.parse(s) as unknown)
    expect(payloads).toContainEqual(
      expect.objectContaining({
        _tag: 'Log',
        log: expect.stringContaining('Observations fetched'),
      })
    )
  })

  it('no-ops gracefully when #h2, #log, or the button are missing', () => {
    document.body.innerHTML = ''
    window.fetch = vi.fn().mockResolvedValue(new Response('ok'))
    expect(() =>
      bootstrapFhirPage({
        patientUrl: 'https://e.test/Patient/42',
        observationUrl: 'https://e.test/Observation',
      })
    ).not.toThrow()
  })
})

describe('buildFhirBootstrapHtml', () => {
  it('renders an HTML page whose <script> body includes the two URLs (JSON-quoted, `<` escaped)', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.webUrl(), (patientUrl, observationUrl) => {
        const html = buildFhirBootstrapHtml({ patientUrl, observationUrl })
        // URLs are JSON-stringified in the <script> with `<` further
        // replaced by `<`; mirror that transformation to find them
        // in the rendered HTML.
        // oxlint-disable-next-line eslint-plugin-unicorn/consistent-function-scoping
        const safeEmbed = (s: string): string => JSON.stringify(s).replace(/</g, '\\u003c')
        expect(html).toContain(safeEmbed(patientUrl))
        expect(html).toContain(safeEmbed(observationUrl))
        expect(html).toMatch(/^<!DOCTYPE html>/)
        expect(html).toMatch(/<\/html>\s*$/)
      })
    )
  })

  it('entity-encodes HTML-significant characters in the patient URL inside the <h1>', () => {
    const html = buildFhirBootstrapHtml({
      patientUrl: 'https://e.test/Patient/<script>alert(1)</script>',
      observationUrl: 'https://e.test/Observation',
    })
    const h1Region = html.slice(html.indexOf('<h1'), html.indexOf('</h1>'))
    expect(h1Region).toContain('&lt;script&gt;')
    expect(h1Region).not.toContain('<script>')
  })

  it('escapes `<` in the JSON-embedded config so an attacker-controlled URL cannot break out of the <script>', () => {
    const html = buildFhirBootstrapHtml({
      patientUrl: 'https://evil/</script><script>alert(1)//',
      observationUrl: 'https://e.test/Observation',
    })
    const scriptStart = html.indexOf('<script>')
    const scriptEnd = html.indexOf('</script>', scriptStart + 1)
    // The IIFE block must extend to the closing </script> of THIS bootstrap
    // script — not an embedded `</script>` from the patientUrl. The raw
    // `</script>` substring must not appear inside the IIFE region.
    const scriptBlock = html.slice(scriptStart, scriptEnd)
    expect(scriptBlock).not.toContain('</script>')
    // The escaped form `</script>` must be what's embedded.
    expect(scriptBlock).toContain('\\u003c/script>')
  })
})
