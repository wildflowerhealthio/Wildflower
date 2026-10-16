import {
  anonymizeHost,
  type HostRedactor,
  isTelemetryEnabled,
  makeEffectTracerLayer,
  makeHostRedactor,
  scrubEvent,
  type TelemetryConfig,
  type TelemetryConsent,
  telemetryConfigFor,
} from '@wildflowerhealthio/telemetry-core'
import { Layer } from 'effect'
import { initWebTelemetry } from './layer.ts'
import { type InitSentryWebOptions, Sentry } from './sentry.ts'

/**
 * The tags every event an app reports carries, set on Sentry's global scope.
 *
 * @remarks
 * `app` names the app (its Sentry project is chosen by its DSN, so this
 * separates apps that share one); `launch` is where in a SMART app the visitor
 * is: `launching` on the launch page that authorizes a launch the URL
 * carries, `standalone` on the connect page, `launched` in the app a completed
 * SMART launch opened. An EHR launch and a standalone one return to the same
 * redirect target with the same callback, so the tag does not tell them apart.
 * Further string tags ride along under their own names.
 */
interface TelemetryTags {
  readonly app: string
  readonly launch?: 'launching' | 'standalone' | 'launched'
  readonly [tag: string]: string | undefined
}

/** Options for {@link initConsentedTelemetry}. */
interface InitConsentedTelemetryOptions {
  /** The visitor's answer, or `undefined` while they have not given one. */
  readonly consent: TelemetryConsent | undefined
  /** The app's build-time config, before `consent` narrows it. */
  readonly config: TelemetryConfig
  /** Set on Sentry's global scope once telemetry starts. */
  readonly tags: TelemetryTags
}

/** The Sentry tag {@link setFhirServerHost} sets. */
const FHIR_SERVER_HOST_TAG = 'fhir_server_host'

/**
 * The {@link FHIR_SERVER_HOST_TAG} value for an empty host. Sentry drops a tag
 * whose value is empty, which would read as never set.
 */
const EMPTY_FHIR_SERVER_HOST = '{empty}'

/** The {@link FHIR_SERVER_HOST_TAG} value for a FHIR server with no host to read. */
const NO_FHIR_SERVER_HOST = '{null}'

/**
 * What the SDK collects beyond the event itself: nothing that identifies the
 * visitor or carries a request's contents.
 *
 * @remarks
 * No user fields, cookies, HTTP headers or bodies, URL query parameters,
 * GraphQL variables, generative-AI inputs and outputs, or database query
 * values. Stack frames keep their source context, which is the app's code.
 */
const PERSONAL_DATA_OFF: NonNullable<InitSentryWebOptions['dataCollection']> = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: false, response: false },
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
}

/**
 * The latest answer handed to {@link initConsentedTelemetry}. The SDK's hooks
 * read it for every event, so a switch turned off stops its events at once.
 */
let latestConsent: TelemetryConsent | undefined

/**
 * The hosts of the servers this page is known to talk to, which every event
 * it sends has replaced with `{host}`; see {@link redactServerHost}.
 */
const serverHosts = new Set<string>()

/**
 * The hosts every event has replaced with `{host}`: {@link serverHosts}, and
 * the page's own, which names the server when the page is served from one.
 * Kept hosts among them (`localhost`, `wildflowerhealth.io`, …) stay as
 * written.
 */
const hostsToRedact = (): readonly string[] =>
  typeof location === 'undefined' ? [...serverHosts] : [...serverHosts, location.host]

/**
 * The redactor for {@link hostsToRedact}, built on first use and rebuilt only
 * when {@link redactServerHost} learns a new host, rather than for every
 * event.
 */
let hostRedactor: HostRedactor | undefined

/** {@link hostRedactor}, built if no event has needed it since the hosts last changed. */
const currentHostRedactor = (): HostRedactor => {
  hostRedactor ??= makeHostRedactor(hostsToRedact())
  return hostRedactor
}

/**
 * The Effect tracer layer for the tracer provider a consent registered, or
 * `undefined` while no answer has registered one. {@link consentedTelemetryLayer}
 * provides it.
 */
let consentedEffectTracerLayer: Layer.Layer<never> | undefined

/**
 * The `Sentry.init` options that hold the SDK to what the visitor consented
 * to.
 *
 * @param initialConsent - The answer the SDK starts with
 *
 * @remarks
 * {@link PERSONAL_DATA_OFF} applies whatever the answer. Browser tracing is
 * added only when `initialConsent` has `performance`, with INP off: INP is
 * sent as a standalone span, which bypasses `beforeSendTransaction`, so
 * neither the consent check nor `scrubEvent` would see it. Nothing adds
 * session replay or profiling. Each hook drops the events its switch does not
 * cover in {@link latestConsent} — error events without `crashReports`,
 * transactions without `performance` — and anonymizes the URLs in the ones it
 * sends, with the hosts {@link hostsToRedact} names as they stand when the
 * event is sent.
 */
const sentryOptionsFor = (initialConsent: TelemetryConsent): InitSentryWebOptions => ({
  dataCollection: PERSONAL_DATA_OFF,
  integrations: initialConsent.performance
    ? [Sentry.browserTracingIntegration({ enableInp: false })]
    : [],
  beforeSend: (errorEvent) =>
    latestConsent?.crashReports === true ? scrubEvent(errorEvent, currentHostRedactor()) : null,
  beforeSendTransaction: (transactionEvent) =>
    latestConsent?.performance === true
      ? scrubEvent(transactionEvent, currentHostRedactor())
      : null,
})

/**
 * Start browser telemetry as far as the visitor consented to it, and not at
 * all while they have not said yes.
 *
 * @returns Whether a telemetry sink is running: `false` when `consent` is
 *   undecided or turns both switches off, or when `config` names no sink the
 *   consent allows
 *
 * @remarks
 * `config` is first narrowed by `telemetryConfigFor`, which leaves no sink
 * until one switch is on, so an app that never gets a yes never touches the
 * SDK. With a yes, `tags` are set on the global scope and the narrowed config
 * is handed to {@link initWebTelemetry} with the options `sentryOptionsFor`
 * derives from `consent`; the tracer provider that registers is the one
 * {@link consentedTelemetryLayer} binds Effect's spans to.
 *
 * Call it again whenever the answer changes. The SDK initializes once per page
 * load, keeping its first options, but its hooks follow the latest answer: a
 * switch turned off stops its events at once, crash reports turned on start
 * at once, and performance turned on after the SDK started without it takes
 * effect on the next page load, when browser tracing is added.
 */
const initConsentedTelemetry = ({
  consent,
  config,
  tags,
}: InitConsentedTelemetryOptions): boolean => {
  latestConsent = consent
  const consentedConfig = telemetryConfigFor(consent, config)
  if (consent === undefined || !isTelemetryEnabled(consentedConfig)) return false
  Sentry.getGlobalScope().setTags(tags)
  const tracerProvider = initWebTelemetry(consentedConfig, sentryOptionsFor(consent))
  if (tracerProvider !== undefined && consentedEffectTracerLayer === undefined) {
    consentedEffectTracerLayer = makeEffectTracerLayer(consentedConfig)
  }
  return true
}

/**
 * The Effect telemetry layer for an app that asks first: Effect's spans go to
 * the tracer provider {@link initConsentedTelemetry} registered, while the
 * latest answer has performance on, and nowhere otherwise.
 *
 * @remarks
 * Suspended, so importing or composing it starts nothing, and re-read each
 * time a runtime builds it: an app that provides it per request (the
 * launcher's `runAuthed`) traces from the first request after a yes turns
 * performance on, and stops with the first after it is turned off. Until an
 * answer registers the provider it is `Layer.empty`. It never initializes
 * anything itself.
 */
const consentedTelemetryLayer: Layer.Layer<never> = Layer.suspend(() =>
  consentedEffectTracerLayer !== undefined && latestConsent?.performance === true
    ? consentedEffectTracerLayer
    : Layer.empty
)

/**
 * Replace `host` with `{host}` wherever an event sent from now on names it
 * outside a URL field (which `scrubEvent` anonymizes whatever its host): in
 * stack frames' script URLs, messages, exception messages, breadcrumbs, span
 * descriptions, the transaction name, tags, `extra` and contexts.
 *
 * @param host - A server's host, with or without a port, or an `http(s)` URL
 *   on it (its origin, a FHIR base URL); matched case-insensitively, with any
 *   port and any subdomains. A value that names no host, such as a path, is
 *   ignored
 *
 * @remarks
 * For the hosts an app learns at run time: `setFhirServerHost` redacts the
 * FHIR server's, the launcher each server it signs in to or is pointed at,
 * and the Tauri host's base each server's domain. Every
 * `*.relay.wildflowerhealth.io` host and the page's own are redacted without
 * it. A kept host (`localhost`, `wildflowerhealth.io`, …) stays as written.
 */
const redactServerHost = (host: string): void => {
  if (serverHosts.has(host)) return
  serverHosts.add(host)
  hostRedactor = undefined
}

/** The {@link FHIR_SERVER_HOST_TAG} value for `fhirServerHost` (see {@link setFhirServerHost}). */
const fhirServerHostTagValue = (fhirServerHost: string | null | undefined): string => {
  if (fhirServerHost === null || fhirServerHost === undefined) return NO_FHIR_SERVER_HOST
  if (fhirServerHost === '') return EMPTY_FHIR_SERVER_HOST
  return anonymizeHost(fhirServerHost)
}

/**
 * Tag every event reported from now on with the host of the FHIR server the
 * app is connected to, reduced by `anonymizeHost`, and redact the host
 * wherever else the events name it (see {@link redactServerHost}).
 *
 * @param fhirServerHost - The host (with port, if any) of the FHIR base URL,
 *   or `null` or `undefined` when the app has a FHIR server but no host to
 *   read from it
 *
 * @remarks
 * The tag tells four cases apart: a kept host as written (`localhost:8080`),
 * any other host as `{host}`, an empty host as {@link EMPTY_FHIR_SERVER_HOST},
 * no host as {@link NO_FHIR_SERVER_HOST}; and no tag at all while this has not
 * been called.
 */
const setFhirServerHost = (fhirServerHost: string | null | undefined): void => {
  if (typeof fhirServerHost === 'string') redactServerHost(fhirServerHost)
  Sentry.getGlobalScope().setTag(FHIR_SERVER_HOST_TAG, fhirServerHostTagValue(fhirServerHost))
}

export type { InitConsentedTelemetryOptions, TelemetryTags }
export { consentedTelemetryLayer, initConsentedTelemetry, redactServerHost, setFhirServerHost }
