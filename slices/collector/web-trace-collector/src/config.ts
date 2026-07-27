import {
  CollectorDescriptor,
  type EntityDefinition,
  ScrapingPlan,
  type WebViewSource,
} from 'collector-fundamentals/model'
import * as Telemetry from 'collector-fundamentals/telemetry'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import { makePersistResources } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'

import { makeRawExchangeEntity } from './entities/raw-exchange-entity.ts'

/**
 * An absolute `http(s)` URL — the page the recording starts on. Validated by
 * `URL` rather than a regex: the value is handed to the sniffer webview to
 * navigate, so "does the platform's URL parser accept it" is the question that
 * actually matters. A non-`http(s)` scheme is rejected because the sniffer
 * shims `fetch`/`XMLHttpRequest` on a web page and there is nothing to record
 * on a `file:` or `data:` URL.
 */
const isAbsoluteHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

const arbitraryRootUrl: LazyArbitrary<string> = (fc: typeof FastCheck) =>
  // Filter rather than map to a fallback, so the shrinker stays honest —
  // mirroring the `rootUrl` arbitrary in `fhir-r4-client-collector`.
  fc.webUrl({ withQueryParameters: true }).filter(isAbsoluteHttpUrl)

const RootUrlSchema = Schema.String.pipe(
  Schema.filter(isAbsoluteHttpUrl, {
    description: 'an absolute http(s) URL',
  }),
  Schema.maxLength(2048)
).annotations({ arbitrary: () => arbitraryRootUrl })

/**
 * An optional human-readable note on what was being recorded ("prescriptions
 * refill flow"). It is a **label, not an identity** — the session id is minted
 * fresh per run, so two runs of the same remote never collide even when they
 * carry the same label.
 */
const SessionLabelSchema = Schema.String.pipe(Schema.maxLength(200))

/**
 * One `bodyContentTypes` entry: a bare token matched against a response's media
 * type (`json`, `text`, `html`, `xml`, or something narrower like `fhir+json`).
 * Not a full media type with a `/` — see `body-policy.ts`'s token table for how
 * an entry is matched.
 */
const BodyContentTypeSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9!#$&^_.+-]*$/, {
    description: 'a lower-case media-type token, e.g. "json" or "fhir+json"',
  }),
  Schema.maxLength(64)
)

/**
 * Per-body size cap. Bounded above so a config cannot ask the on-device store to
 * absorb an unbounded blob; a body over the cap still records its `size` and
 * `hash`, so raising the cap and re-recording is an informed decision.
 */
const MaxBodyBytesSchema = Schema.Int.pipe(Schema.between(0, 64 * 1024 * 1024))

/**
 * The content types whose bodies a fresh config stores. Chosen as the types a
 * collector author actually reads: API payloads (`json`, covering
 * `application/fhir+json` via the structured suffix), rendered pages (`html`),
 * legacy/SOAP-ish APIs (`xml`), and anything else textual (`text`).
 *
 * Binary — images, fonts, media, `octet-stream` — is deliberately absent: it is
 * bulk with nothing to read, and a skipped body still records its `size` and
 * `hash`, so the trace still says it happened.
 */
const DEFAULT_BODY_CONTENT_TYPES: readonly string[] = ['json', 'text', 'html', 'xml']

/**
 * 1 MiB. Comfortably holds the JSON and HTML a portal returns while stopping one
 * bundled script or inlined asset from dominating a recording.
 */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

const InstanceConfig = Schema.TaggedStruct('web-trace', {
  rootUrl: RootUrlSchema,
  sessionLabel: Schema.optional(SessionLabelSchema),
  bodyContentTypes: Schema.Array(BodyContentTypeSchema),
  maxBodyBytes: MaxBodyBytesSchema,
})

type InstanceConfig = typeof InstanceConfig.Type

/**
 * Seeds a fresh create-form. `example.com` is an obviously-placeholder root the
 * user overwrites with the portal they mean to record; the body policy defaults
 * are the ones most recordings should keep.
 */
const defaultConfig: InstanceConfig = {
  _tag: 'web-trace',
  rootUrl: 'https://example.com',
  bodyContentTypes: DEFAULT_BODY_CONTENT_TYPES,
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
}

/**
 * How long the recording may stay parked waiting for the user to close the
 * window. Long enough for a real exploratory session; the hold ends by WARN
 * rather than hanging if the user walks away.
 */
const USER_DISMISS_TIMEOUT = Duration.hours(2)

/**
 * The plan's silent-host guard. **Must sit above {@link USER_DISMISS_TIMEOUT}** —
 * the sync runner does not know the hold is waiting on a person, and its 30 s
 * default would abandon the run first. See the `AwaitUserDismiss` trap in
 * [slices/collector/AGENTS.md](../AGENTS.md).
 */
const IDLE_TIMEOUT = Duration.hours(3)

/**
 * Mint the id every exchange in one recording shares.
 *
 * @param config - The remote's config, for its optional label
 * @returns A fresh session id, prefixed with the label when there is one
 *
 * @remarks
 * The uuid is what makes two runs of the same configured remote distinct, so
 * `{sessionId}-{requestId}` cannot silently upsert the second recording over the
 * first. The label is a readability prefix only — deriving the id from it alone
 * would collide on exactly the case a user is most likely to hit.
 */
const mintSessionId = (config: InstanceConfig): string => {
  const uuid = globalThis.crypto.randomUUID()
  const label = config.sessionLabel?.trim()
  return label === undefined || label === '' ? uuid : `${label}-${uuid}`
}

/**
 * Build the web-trace scraping plan for a configured root URL.
 *
 * @param config - The remote's stored config
 * @returns A plan that opens the root URL and then hands the browser to the user
 *
 * @remarks
 * The run model everywhere else in this slice is *scripted*; this one is
 * *exploratory*. An empty `stepSequence` would complete the instant the first
 * `PageLoaded` settled — before the user had clicked anything — so completion is
 * deferred to them by `[EnsureWindowVisible, AwaitUserDismiss]`.
 *
 * **The session id is minted here, once per plan build**, and the entity closes
 * over it. `makeScrapingPlan` is called exactly once per sync run, so one plan
 * build is one recording — which does make this factory impure, by design. See
 * the [package AGENTS.md](../AGENTS.md) for what that costs a caller.
 */
const scrapingPlan = (config: InstanceConfig): ScrapingPlan.ScrapingPlan<FhirResource> => {
  const firstPage: WebViewSource.Any = { _tag: 'Uri', uri: config.rootUrl }
  const entity = makeRawExchangeEntity({
    sessionId: mintSessionId(config),
    policy: { bodyContentTypes: config.bodyContentTypes, maxBodyBytes: config.maxBodyBytes },
  })
  return ScrapingPlan.make<FhirResource>({
    name: 'Web Trace',
    // Widening upcast (safe: `EntityDefinition` is covariant in its resource
    // type, and `DocumentReference` is a `FhirResource`), mirroring
    // `rexall-be-well-collector`.
    entityDefinitions: [entity] as readonly EntityDefinition.EntityDefinition<FhirResource>[],
    firstPage,
    stepSequence: [
      {
        _tag: 'EnsureWindowVisible',
        name: 'Opening the browser',
      },
      {
        _tag: 'AwaitUserDismiss',
        name: 'Recording — close this window when you are done',
        timeout: USER_DISMISS_TIMEOUT,
      },
    ],
    idleTimeout: IDLE_TIMEOUT,
  })
}

/**
 * The descriptor's persist sink: `fhir-r4`'s shared batch write, told to report
 * itself in the collector slice's telemetry vocabulary. The retries, per-resource
 * span, concurrency bound, and failure-as-data accounting all live in
 * {@link makePersistResources}; only the names are ours.
 */
const persistResources = makePersistResources({
  spanName: Telemetry.Importing.Update.Span.Name,
  kindAttributeKey: Telemetry.Importing.Update.Span.Attributes.Kind,
  logLabel: 'web-trace persist',
})

/**
 * The web-trace collector as one first-class value for `collector-registry`.
 *
 * @remarks
 * `title` names the collector kind; `listSubtitle` shows the configured root URL,
 * suffixed with the session label when the user set one, since a user may keep
 * several recordings of different flows against the same portal.
 */
const WebTraceCollectorDescriptor = CollectorDescriptor.make({
  tag: 'web-trace',
  configSchema: InstanceConfig,
  defaultConfig,
  makeScrapingPlan: scrapingPlan,
  display: {
    title: 'Web Trace',
    description: 'Record a browsing session against a portal, for designing a collector',
    listSubtitle: (config) =>
      config.sessionLabel === undefined || config.sessionLabel === ''
        ? config.rootUrl
        : `${config.rootUrl} — ${config.sessionLabel}`,
  },
  persistResources,
})

export {
  DEFAULT_BODY_CONTENT_TYPES,
  DEFAULT_MAX_BODY_BYTES,
  defaultConfig,
  IDLE_TIMEOUT,
  InstanceConfig,
  isAbsoluteHttpUrl,
  mintSessionId,
  scrapingPlan,
  USER_DISMISS_TIMEOUT,
  WebTraceCollectorDescriptor,
}
