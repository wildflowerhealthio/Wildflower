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
 * Build the FHIR R4 scraping plan for a configured patient on a
 * configured server. The plan's `firstPage` navigates the
 * BrowserSnifferWebView straight to `/Patient/:id?_format=json`; the
 * mobile WebView renders the JSON inside its built-in JSON viewer
 * (`<pre>…JSON…</pre>`), the sniffer streams that DOM, and
 * `PatientEntity.parse` extracts the JSON via `extractJson`. Once the
 * Patient page is settled, `linkSequence[0]` navigates to the bundled
 * `/Observation?subject:Patient=…&_count=250` URL; the same
 * intercept-and-extract flow yields the Observation Bundle entries.
 *
 * `stepDelay` is a flat 5 seconds — enough for the FHIR server's
 * round-trip plus the WebView's JSON-viewer paint on a slow tablet.
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
  const firstPage: WebViewSource.Any = { _tag: 'Uri', uri: patientUrl }
  return ScrapingPlan.make<AnyResource>({
    name: 'FHIR R4',
    entityDefinitions: [
      PatientEntity,
      ObservationEntity,
      ObservationListEntity,
    ] as readonly EntityDefinition.EntityDefinition<AnyResource>[],
    firstPage,
    linkSequence: [{ _tag: 'Open', source: { _tag: 'Uri', uri: observationUrl } }],
    stepDelay: Duration.seconds(5),
  })
}

export { InstanceConfig, defaultConfig, scrapingPlan }
export type { AnyResource }
