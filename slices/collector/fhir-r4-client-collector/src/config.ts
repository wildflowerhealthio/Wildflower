import {
  CollectorDescriptor,
  type EntityDefinition,
  ScrapingPlan,
} from 'collector-fundamentals/model'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import { persistResources } from 'fhir-r4/clients'
import { adoptSourceIdentity } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'

import { makeFhirProvenanceCapture } from 'web-trace-core/provenance'

import { ObservationEntity } from './entities/observation-entity.ts'
import { ObservationListEntity } from './entities/observation-list-entity.ts'
import { PatientEntity } from './entities/patient-entity.ts'

/**
 * `rootUrl` must be an absolute `http(s)://` URL with at least a host
 * and no trailing slash, no query string, and no fragment. A base path
 * is allowed (`https://hapi.fhir.org/baseR4`) — real FHIR servers mount
 * the resource tree under a prefix. The dispatcher concatenates
 * `rootUrl` with `/Patient/…` etc., and `UrlMatch` tolerates the base
 * path between host and resource segment (see issue #376), so the two
 * agree; pinning the format here keeps both producers and consumers honest.
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

// The scraping/parsing entities below produce only Binary / Patient /
// Observation today. The write surface (`fhir-r4`'s `FhirResource` union +
// `upsertResource`) already covers `MedicationRequest` / `MedicationDispense`
// ahead of the Rexall collector ticket that adds the entities emitting them
// (issue #334), so this plan needs no widening when they arrive.

/** Machine-side cap on waiting for the Patient JSON document to settle. */
const PATIENT_TIMEOUT = Duration.seconds(30)
/** Machine-side cap on waiting for the Observation page to settle. */
const OBSERVATION_TIMEOUT = Duration.seconds(30)

/**
 * This collector's provenance hook: every response an entity derives a
 * resource from is stored verbatim as a trace `DocumentReference`, linked
 * both ways to the resources it produced. Module-level — not built inside
 * the factory — so two plans built from one config share the reference and
 * stay deep-equal (`toEqual` compares functions by identity).
 */
const captureProvenance = makeFhirProvenanceCapture('fhir-r4')<FhirResource>

/**
 * Build the FHIR R4 scraping plan for a configured patient on a
 * configured server. The plan's first `Open` step builds the sniffer webview
 * directly on `/Patient/:id?_format=json`. The
 * browser-sniffer's window-`load` handler snapshots the rendered document (the
 * browser's native JSON viewer wraps the response in `<pre>{json}</pre>`),
 * streams it through the standard `ResponseStart`/`Data`/`Finished` triple keyed
 * on the FHIR URL, and `PatientEntity.parse` extracts the JSON via
 * `extractJson`. A pattern-less `AwaitPageSettled` holds until that Patient page
 * has settled, then the next `Open` step navigates the WebView to
 * `/Observation?subject:Patient=…&_count=250`; the same snapshot-and-extract
 * flow yields the Observation Bundle entries, gated by a second pattern-less
 * `AwaitPageSettled`.
 *
 * A `Navigation` dispatches and advances immediately (it never waits for a
 * `PageLoaded`), so each `Open` is followed by an `AwaitPageSettled` hold that
 * keeps the run open until that page has actually loaded and settled — without
 * it the queue would drain the instant the `Open` dispatches and the run could
 * complete before the request is even tracked. The holds are **pattern-less**:
 * each waits for the *next* settle after its `Open` (skipping the prior page),
 * which is unambiguous because each `Open` targets a fresh document. The FHIR endpoints are direct JSON documents (one request per
 * page, no post-load XHR fan-out), so the hold on the settled page is
 * sufficient — no additional fixed `Delay` grace step is needed.
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
 *
 * The plan is wrapped in `adoptSourceIdentity` so every resource it parses is
 * re-keyed under the configured server's namespace: a derived local id, the
 * server's own id kept as `identifier[0]`, and references rewritten to match.
 * The source system is `config.rootUrl` — the configured root, never a URL
 * recovered from a response — and it doubles as `baseUrl`, so a server that
 * spells its self-references absolutely rewrites them the same as relative ones.
 *
 * Provenance is the plan-level `captureProvenance` hook — the whole of this
 * collector's wiring is the one line naming it. The framework mints the run
 * id (this factory ignores its `runId` parameter — the hook receives it at
 * invocation), invokes the hook only for a response whose parse produced
 * resources, and persists the resulting trace best-effort. The factory stays
 * deterministic given its inputs, so tests deep-equal plans built from one
 * config.
 */
const scrapingPlan = (
  config: InstanceConfig,
  _runId: string
): ScrapingPlan.ScrapingPlan<FhirResource> => {
  const safePatientId = encodeURIComponent(config.patientId)
  const patientUrl = `${config.rootUrl}/Patient/${safePatientId}?_format=json`
  const observationUrl = `${config.rootUrl}/Observation?subject%3APatient=${safePatientId}&_count=250&_format=json`
  const plan = ScrapingPlan.make<FhirResource>({
    name: 'FHIR R4',
    entityDefinitions: [
      PatientEntity,
      ObservationEntity,
      ObservationListEntity,
    ] as readonly EntityDefinition.EntityDefinition<FhirResource>[],
    captureProvenance,
    stepSequence: [
      // Open the Patient JSON document — the step that brings the sniffer up —
      // then hold until it settles before opening the Observation page.
      {
        _tag: 'Navigation',
        name: 'Loading patient',
        action: {
          _tag: 'Open',
          source: {
            _tag: 'Uri',
            uri: patientUrl,
          },
        },
      },
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for patient to load',
        timeout: PATIENT_TIMEOUT,
      },
      {
        _tag: 'Navigation',
        name: 'Loading observations',
        action: {
          _tag: 'Open',
          source: {
            _tag: 'Uri',
            uri: observationUrl,
          },
        },
      },
      // Keep the run open until the Observation page has loaded and settled — the
      // `Open` above dispatches and advances immediately, so without this hold the
      // queue would drain before the Observation request is tracked.
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for observations to load',
        timeout: OBSERVATION_TIMEOUT,
      },
    ],
  })
  return adoptSourceIdentity({ system: config.rootUrl, baseUrl: config.rootUrl })(plan)
}

/**
 * The FHIR R4 collector as one first-class value: the config schema,
 * its default, the plan factory, and the user-facing strings, bundled
 * for `collector-registry` to assemble into the closed descriptor list
 * (issue #387). The display strings are the honest kind-level values —
 * the "Demo FHIR Server" label previously hardcoded in `collector-react`
 * names a *route's demo entry*, not the collector, so it stays there;
 * this descriptor's `title` is the collector kind ("FHIR R4") and its
 * `listSubtitle` surfaces a remote's configured `rootUrl`.
 */
const FhirR4CollectorDescriptor = CollectorDescriptor.make({
  tag: 'fhir-r4',
  configSchema: InstanceConfig,
  defaultConfig,
  makeScrapingPlan: scrapingPlan,
  display: {
    title: 'FHIR R4',
    description: 'Health records from a FHIR R4 server',
    listSubtitle: (config) => config.rootUrl,
  },
  persistResources,
})

export { InstanceConfig, defaultConfig, scrapingPlan, FhirR4CollectorDescriptor }
