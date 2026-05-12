// oxlint-disable eslint-plugin-unicorn/require-post-message-target-origin -- RN-WebView's bridge `postMessage(string)` is not the window `postMessage` API; no `targetOrigin` argument exists (mirrors browser-sniffer-injected/install-sniffer).

import type { LogMessageBody } from 'browser-sniffer-core'
import type { Schema } from 'effect'

/** The wire shape of `browser-sniffer-core`'s `Log` Web→Host message. */
type SnifferLogPayload = Schema.Schema.Encoded<typeof LogMessageBody>

/**
 * Inline-script body for the FHIR R4 bootstrap page.
 *
 * The page rendered by `FhirR4Remote.firstPage` ships an empty
 * `<h2 id="h2">` placeholder, a `<button id="fetch-observations">`,
 * and a `<pre id="log">` panel. This function:
 *   - Wires the button click to fetch the observation list. The
 *     fetch itself is the point — the sniffer intercepts the network
 *     call and pushes a `ResponseStart` / `ResponseData` /
 *     `ResponseFinished` triple. Outcomes (success or failure) are
 *     written to `#log` *and* posted Web→Host on the browser-sniffer
 *     bridge's `Log` channel so the host sees them in its own log
 *     stream.
 *   - After 500ms, fetches the patient resource and writes the raw
 *     response body into the `<h2>`. Failures land in `#h2` and
 *     `#log` and are posted via the bridge.
 *
 * Produced wire form: `(${bootstrapFhirPage.toString()})({patientUrl, observationUrl})`
 * embedded inside `<script>` tags. The function body must therefore
 * use only browser globals (`document`, `fetch`, `setTimeout`,
 * `String`, `JSON`, `window`) — top-level imports would resolve to
 * nothing when the stringified body is re-evaluated by the WebView.
 * Type-only imports (`LogMessageBody`) are erased at compile time and
 * so do survive.
 *
 * Test coverage in `bootstrap-fhir-page.test.ts`.
 */
const bootstrapFhirPage = function (config: {
  readonly patientUrl: string
  readonly observationUrl: string
}): void {
  const winWithRnwv = window as Window & {
    ReactNativeWebView?: { postMessage(data: string): void }
  }

  const postLog = (text: string): void => {
    const logEl = document.getElementById('log')
    if (logEl !== null) {
      logEl.textContent = (logEl.textContent ?? '') + text + '\n'
    }
    const rnwv = winWithRnwv.ReactNativeWebView
    if (rnwv !== undefined && typeof rnwv.postMessage === 'function') {
      const payload: SnifferLogPayload = { _tag: 'Log', log: text }
      rnwv.postMessage(JSON.stringify(payload))
    }
  }

  const button = document.getElementById('fetch-observations')
  if (button !== null) {
    button.addEventListener('click', () => {
      postLog(`Fetching observations: ${config.observationUrl}`)
      fetch(config.observationUrl)
        .then((res) => res.text())
        .then((body) => {
          postLog(`Observations fetched (${body.length} bytes)`)
        })
        .catch((err: unknown) => {
          postLog(`Observation fetch failed: ${String(err)}`)
        })
    })
  }

  setTimeout(() => {
    const h2 = document.getElementById('h2')
    if (h2 !== null) h2.textContent = 'Fetching'
    fetch(config.patientUrl)
      .then((res) => res.text())
      .then((text) => {
        if (h2 !== null) h2.textContent = text
        postLog(`Patient fetched (${text.length} bytes)`)
      })
      .catch((err: unknown) => {
        const message = String(err)
        if (h2 !== null) h2.textContent = message
        postLog(`Patient fetch failed: ${message}`)
      })
  }, 500)
}

/**
 * Build the FHIR R4 bootstrap HTML page. Embeds the
 * {@link bootstrapFhirPage} body via `Function.prototype.toString()`
 * with the URLs threaded through `JSON.stringify` so the resulting
 * inline `<script>` is a syntactically valid IIFE regardless of the
 * URL's punctuation.
 *
 * The `<h1>` prints the patient URL with HTML-significant characters
 * entity-encoded, so an attacker-controlled rootUrl can't break out
 * of the heading and inject markup. Inside the `<script>` block,
 * `JSON.stringify` is not enough on its own — it does not escape
 * `<`, so a URL containing `</script>` would close the script tag.
 * After `JSON.stringify` we replace `<` with its `<`
 * representation (and the two line separators `
` / `
`,
 * which are valid in JSON strings but illegal in JS source) to
 * preserve script-context boundary safety.
 */
const buildFhirBootstrapHtml = (config: {
  readonly patientUrl: string
  readonly observationUrl: string
}): string => {
  const safePatientUrl = config.patientUrl
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
  const serializedConfig = JSON.stringify(config)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>FHIR Resource Loader</title>
  </head>
  <body>
    <h1>Patient data from ${safePatientUrl}</h1>
    <button id="fetch-observations" style="padding: 2em; font-size: 3em">
      Fetch Observations
    </button>
    <h2 id="h2">Loading...</h2>
    <pre id="log" style="white-space: pre-wrap; font-family: monospace; font-size: 0.9em; padding: 1em; background: #f4f4f4; border: 1px solid #ddd"></pre>
    <script>(${bootstrapFhirPage.toString()})(${serializedConfig})</script>
  </body>
</html>`
}

export { bootstrapFhirPage, buildFhirBootstrapHtml }
