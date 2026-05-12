/**
 * Inline-script body for the FHIR R4 bootstrap page.
 *
 * The page rendered by `FhirR4Remote.firstPage` ships an empty
 * `<h2 id="h2">` placeholder and a `<button id="fetch-observations">`.
 * This function:
 *   - Wires the button click to fetch the observation list and
 *     `console.log` the result (debug-only — the sniffer captures the
 *     network call regardless).
 *   - After 500ms, fetches the patient resource and writes the raw
 *     response body into the `<h2>`; on failure, the error message
 *     goes into the same `<h2>`. The fetch itself is the point — the
 *     sniffer intercepts it and pushes a `ResponseStart` /
 *     `ResponseData` / `ResponseFinished` triple back through the
 *     bridge, which `FhirR4Remote` parses into resources.
 *
 * Produced wire form: `(${bootstrapFhirPage.toString()})({patientUrl, observationUrl})`
 * embedded inside `<script>` tags. The function body must therefore
 * use only browser globals (`document`, `fetch`, `setTimeout`,
 * `console`, `alert`, `String`) — top-level imports would resolve to
 * nothing when the stringified body is re-evaluated by the WebView.
 *
 * Test coverage in `bootstrap-fhir-page.test.ts`.
 */
const bootstrapFhirPage = function (config: {
  readonly patientUrl: string
  readonly observationUrl: string
}): void {
  const button = document.getElementById('fetch-observations')
  if (button !== null) {
    button.addEventListener('click', () => {
      fetch(config.observationUrl)
        .then((res) => res.json())
        .then((data: unknown) => {
          // oxlint-disable-next-line eslint/no-console
          console.log(data)
        })
        .catch((err: unknown) => {
          alert(String(err))
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
      })
      .catch((err: unknown) => {
        if (h2 !== null) h2.textContent = String(err)
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
 * of the heading and inject markup. (The same URL is JSON-escaped for
 * the script payload separately.)
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
    <script>(${bootstrapFhirPage.toString()})(${serializedConfig})</script>
  </body>
</html>`
}

export { bootstrapFhirPage, buildFhirBootstrapHtml }
