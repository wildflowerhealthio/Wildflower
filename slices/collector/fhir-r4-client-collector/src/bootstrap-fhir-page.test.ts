import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { bootstrapFhirPage, buildFhirBootstrapHtml } from './bootstrap-fhir-page.ts'

const originalFetch = window.fetch

const setupDom = (): { h2: HTMLElement; button: HTMLElement } => {
  document.body.innerHTML = `
    <button id="fetch-observations"></button>
    <h2 id="h2">Loading...</h2>
  `
  return {
    h2: document.getElementById('h2')!,
    button: document.getElementById('fetch-observations')!,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.useRealTimers()
  window.fetch = originalFetch
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

  it('writes the fetch error message into #h2 on failure', async () => {
    const { h2 } = setupDom()
    window.fetch = vi.fn().mockRejectedValue(new Error('network down'))

    bootstrapFhirPage({
      patientUrl: 'https://e.test/Patient/42',
      observationUrl: 'https://e.test/Observation',
    })

    await vi.advanceTimersByTimeAsync(500)
    await vi.runAllTimersAsync()
    expect(h2.textContent).toContain('network down')
  })

  it('wires the fetch-observations button to fire fetch on click', async () => {
    const { button } = setupDom()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('[]', { headers: { 'content-type': 'application/json' } }))
    window.fetch = fetchMock

    bootstrapFhirPage({
      patientUrl: 'https://e.test/Patient/42',
      observationUrl: 'https://e.test/Observation',
    })

    button.click()
    // Allow the promise chain (.then(json).then(log)) to settle
    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledWith('https://e.test/Observation')
  })

  it('no-ops gracefully when #h2 or the button are missing', () => {
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
  it('renders an HTML page whose <script> body includes the two URLs (JSON-quoted)', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.webUrl(), (patientUrl, observationUrl) => {
        const html = buildFhirBootstrapHtml({ patientUrl, observationUrl })
        // URLs are JSON-stringified in the <script>; the JSON form is what's embedded.
        expect(html).toContain(JSON.stringify(patientUrl))
        expect(html).toContain(JSON.stringify(observationUrl))
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
    // The raw `<script>` substring should NOT appear inside the <h1>; the
    // entity-encoded form should.
    const h1Region = html.slice(html.indexOf('<h1'), html.indexOf('</h1>'))
    expect(h1Region).toContain('&lt;script&gt;')
    expect(h1Region).not.toContain('<script>')
  })
})
