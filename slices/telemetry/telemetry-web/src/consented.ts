import { Layer } from 'effect'
import {
  isTelemetryEnabled,
  makeEffectTracerLayer,
  scrubEvent,
  type TelemetryConfig,
  type TelemetryConsent,
  telemetryConfigFor,
} from 'telemetry-core'
import { initWebTelemetry } from './layer.ts'
import { type InitSentryWebOptions, Sentry } from './sentry.ts'

/**
 * The tags every event an app reports carries, set on Sentry's global scope.
 *
 * @remarks
 * `app` names the app (its Sentry project is chosen by its DSN, so this
 * separates apps that share one); `launch` is where in a SMART app the visitor
 * is: `standalone` on the connect page, `launched` in the app a completed SMART
 * launch opened. An EHR launch and a standalone one return to the same
 * redirect target with the same callback, so the tag does not tell them apart.
 * Further string tags ride along under their own names.
 */
interface TelemetryTags {
  readonly app: string
  readonly launch?: 'standalone' | 'launched'
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
 * added only when `initialConsent` has `performance`; nothing adds session
 * replay or profiling. Each hook drops the events its switch does not cover in
 * {@link latestConsent} — error events without `crashReports`, transactions
 * without `performance` — and anonymizes the URLs in the ones it sends.
 */
const sentryOptionsFor = (initialConsent: TelemetryConsent): InitSentryWebOptions => ({
  dataCollection: PERSONAL_DATA_OFF,
  integrations: initialConsent.performance ? [Sentry.browserTracingIntegration()] : [],
  beforeSend: (errorEvent) =>
    latestConsent?.crashReports === true ? scrubEvent(errorEvent) : null,
  beforeSendTransaction: (transactionEvent) =>
    latestConsent?.performance === true ? scrubEvent(transactionEvent) : null,
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
 * time a runtime builds it: an app that provides it per request (the owner
 * UI's `runAuthed`) traces from the first request after a yes turns
 * performance on, and stops with the first after it is turned off. Until an
 * answer registers the provider it is `Layer.empty`. Unlike
 * `webTelemetryLayerFromEnv`, it never initializes anything itself.
 */
const consentedTelemetryLayer: Layer.Layer<never> = Layer.suspend(() =>
  consentedEffectTracerLayer !== undefined && latestConsent?.performance === true
    ? consentedEffectTracerLayer
    : Layer.empty
)

/**
 * Tag every event reported from now on with the host of the FHIR server the
 * app is connected to.
 *
 * @param fhirServerHost - The host (with port, if any) of the FHIR base URL
 */
const setFhirServerHost = (fhirServerHost: string): void => {
  Sentry.getGlobalScope().setTag(FHIR_SERVER_HOST_TAG, fhirServerHost)
}

export type { InitConsentedTelemetryOptions, TelemetryTags }
export { consentedTelemetryLayer, initConsentedTelemetry, setFhirServerHost }
