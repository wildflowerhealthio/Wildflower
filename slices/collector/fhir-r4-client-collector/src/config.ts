import {
  type EntityDefinition,
  ScrapingPlan,
  type WebViewSource,
} from 'collector-fundamentals/model'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import type { Binary, Observation, Patient } from 'fhir-r4/resources'

import { ObservationEntity } from './entities/observation-entity.ts'
import { ObservationListEntity } from './entities/observation-list-entity.ts'
import { PatientEntity } from './entities/patient-entity.ts'

/**
 * `rootUrl` must be an absolute `http(s)://` URL with at least a host
 * and no trailing slash, no query string, and no fragment. The
 * dispatcher concatenates `rootUrl` with `/Patient/…` etc. and the
 * isFoundAt regexes assume a well-formed `…://host/Patient/…` shape;
 * pinning the format here keeps both producers and consumers honest.
 */
const rootUrlPattern = /^https?:\/\/[^\s/?#]+(?:\/[^\s/?#]+)*$/

/**
 * FHIR R4 logical id grammar (R4 §2.27.1): one or more characters
 * drawn from `[A-Za-z0-9\-.]`, max 64. A patientId is interpolated
 * directly into URLs and used as the route segment — restricting it
 * here means there's nothing surprising to `encodeURIComponent` at
 * call sites.
 */
const patientIdPattern = /^[A-Za-z0-9\-.]{1,64}$/

const arbitraryRootUrl: LazyArbitrary<string> = (fc: typeof FastCheck) =>
  // `fc.webUrl()` can emit trailing slashes and may include a query
  // string under non-default options; we strip the trailing slash so
  // the pattern matches deterministically, and pin scheme/no-extras
  // via options.
  fc
    .webUrl({ validSchemes: ['http', 'https'], withFragments: false, withQueryParameters: false })
    .map((url) => url.replace(/\/+$/, ''))
    // Filter out the rare case where stripping leaves only the
    // scheme (`http://` → `http:`); regenerate via `.filter` instead
    // of mapping to a fallback so the shrinker stays honest.
    .filter((url) => rootUrlPattern.test(url))

const arbitraryPatientId: LazyArbitrary<string> = (fc: typeof FastCheck) => fc.uuid()

const RootUrlSchema = Schema.String.pipe(
  Schema.pattern(rootUrlPattern, {
    description: 'absolute http(s) URL with no trailing slash, query string, or fragment',
  })
).annotations({ arbitrary: () => arbitraryRootUrl })

const PatientIdSchema = Schema.String.pipe(
  Schema.pattern(patientIdPattern, {
    description: 'FHIR R4 logical id: 1–64 chars of [A-Za-z0-9.-]',
  })
).annotations({ arbitrary: () => arbitraryPatientId })

const InstanceConfig = Schema.TaggedStruct('fhir-r4', {
  rootUrl: RootUrlSchema,
  patientId: PatientIdSchema,
})

type InstanceConfig = typeof InstanceConfig.Type

const defaultConfig: InstanceConfig = {
  _tag: 'fhir-r4',
  rootUrl: 'https://r4.smarthealthit.org',
  patientId: '8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882',
}

type AnyResource =
  | typeof Binary.Schema.Type
  | typeof Patient.Schema.Type
  | typeof Observation.Schema.Type

/**
 * Build an inline HTML wrapper document that fetches `url` via
 * `fetch()` and renders the response body into the page.
 *
 * The FHIR JSON endpoints are wrapped in an HTML document instead of
 * being navigated to directly because `react-native-webview`'s
 * `injectedJavaScriptBeforeContentLoaded` — which installs the
 * browser-sniffer — only fires for documents the WebView parses as
 * HTML. Raw `application/json` responses get rendered by a native
 * viewer (especially iOS) without executing any JS, so the sniffer
 * never installs and no `__Ready` / `PageLoaded` / `Response*` events
 * flow back. The wrapper page IS HTML, so the sniffer installs on it,
 * and its `fetch()` call is captured by the sniffer's monkey-patched
 * `fetch` — the streamed response triggers the standard
 * `ResponseStart` / `ResponseData` / `ResponseFinished` triple keyed on
 * the FHIR URL, which the slice's `entityDefinitions` then route.
 *
 * The `fetch()` call is left at the default `credentials: 'same-origin'`
 * so cookie-backed FHIR servers continue to work when the wrapper is
 * loaded with `baseUrl` matching `config.rootUrl` (callers should set
 * that on the `WebViewSource.Html` to keep this request same-origin).
 *
 * @param url - The absolute FHIR URL to fetch from inside the wrapper.
 * @returns A complete HTML document as a string, ready to hand to a
 *   `WebViewSource.Html` `html` field.
 */
const fetchWrapperHtml = (url: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>fhir-r4-sniff</title>
    <style>
      body { margin: 0; font-family: -apple-system, sans-serif; }
      #out { margin: 8px; padding: 8px; background: #f8f8f8; border: 1px solid #ddd; max-height: 60vh; overflow: auto; font-size: 11px; }
      #dbg { position: fixed; bottom: 0; left: 0; right: 0; background: #111; color: #0f0; padding: 8px; font-family: monospace; font-size: 11px; max-height: 35vh; overflow: auto; border-top: 2px solid #0f0; z-index: 9999; }
      #dbg .row { white-space: pre-wrap; word-break: break-all; }
      #dbg .err { color: #f44; }
    </style>
  </head>
  <body>
    <pre id="out">loading…</pre>
    <div id="dbg"></div>
    <script>
      (function () {
        var dbg = document.getElementById('dbg')
        function log(msg, cls) {
          var row = document.createElement('div')
          row.className = 'row' + (cls ? ' ' + cls : '')
          row.textContent = '[' + new Date().toISOString().slice(11, 23) + '] ' + msg
          dbg.appendChild(row)
          dbg.scrollTop = dbg.scrollHeight
        }
        var rnWv = window.ReactNativeWebView
        log('inline-script: running')
        log('RN-WebView: ' + (rnWv && typeof rnWv.postMessage === 'function' ? 'available' : 'MISSING'))
        var snifferSlot = window[Symbol.for('browser-sniffer:state')]
        log('sniffer state slot: ' + (snifferSlot ? 'present' : 'absent'))
        log('document.readyState: ' + document.readyState)
        log('fetch URL: ' + ${JSON.stringify(url)})
        window.addEventListener('load', function () { log('window.load fired') })
        document.addEventListener('DOMContentLoaded', function () { log('DOMContentLoaded fired') })
        log('issuing fetch...')
        fetch(${JSON.stringify(url)})
          .then(function (r) { log('fetch response: ' + r.status + ' ' + r.statusText); return r.text() })
          .then(function (t) {
            log('fetch body: ' + t.length + ' bytes')
            document.getElementById('out').textContent = t
            var slotAfter = window[Symbol.for('browser-sniffer:state')]
            log('sniffer state slot after fetch: ' + (slotAfter ? 'present' : 'absent'))
          })
          .catch(function (e) { log('fetch error: ' + String(e), 'err') })
      })()
    </script>
  </body>
</html>`

/**
 * Build the FHIR R4 scraping plan for a configured patient on a
 * configured server. The plan's `firstPage` mounts an HTML wrapper that
 * `fetch()`es `/Patient/:id?_format=json`; the browser-sniffer's
 * intercepted `fetch` captures the response, streams it through the
 * standard `ResponseStart`/`Data`/`Finished` triple, and
 * `PatientEntity.parse` extracts the JSON via `extractJson`. Once the
 * Patient page is settled, `linkSequence[0]` navigates the WebView to a
 * fresh HTML wrapper around `/Observation?subject:Patient=…&_count=250`;
 * the same intercept-and-extract flow yields the Observation Bundle
 * entries.
 *
 * The wrapper indirection is required because the sniffer JS only runs
 * on documents the WebView parses as HTML — see {@link fetchWrapperHtml}.
 *
 * `stepDelay` is a flat 5 seconds — enough for the FHIR server's
 * round-trip plus the WebView's render on a slow tablet.
 * `entityDefinitions` are listed Patient → Observation → Bundle so
 * `isFoundAt` matches are evaluated in that order; `mustHaveQuery` on
 * the Bundle pattern keeps the list disjoint from the single-resource
 * Observation pattern.
 *
 * `config.rootUrl` and `config.patientId` are pre-validated by
 * {@link InstanceConfig} (no trailing slashes; patientId is the FHIR
 * R4 logical-id grammar) — `encodeURIComponent` on `patientId` is
 * still applied defensively in case the value reaches this function
 * through an untyped path.
 */
const scrapingPlan = (config: InstanceConfig): ScrapingPlan.ScrapingPlan<AnyResource> => {
  const safePatientId = encodeURIComponent(config.patientId)
  const patientUrl = `${config.rootUrl}/Patient/${safePatientId}?_format=json`
  const observationUrl = `${config.rootUrl}/Observation?subject%3APatient=${safePatientId}&_count=250&_format=json`
  const firstPage: WebViewSource.Any = {
    _tag: 'Html',
    html: fetchWrapperHtml(patientUrl),
    baseUrl: config.rootUrl,
  }
  return ScrapingPlan.make<AnyResource>({
    name: 'FHIR R4',
    entityDefinitions: [
      PatientEntity,
      ObservationEntity,
      ObservationListEntity,
    ] as readonly EntityDefinition.EntityDefinition<AnyResource>[],
    firstPage,
    linkSequence: [
      {
        _tag: 'Open',
        source: {
          _tag: 'Html',
          html: fetchWrapperHtml(observationUrl),
          baseUrl: config.rootUrl,
        },
      },
    ],
    stepDelay: Duration.seconds(2),
  })
}

export { InstanceConfig, defaultConfig, scrapingPlan }
export type { AnyResource }
