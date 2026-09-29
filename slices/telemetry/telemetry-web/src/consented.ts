import {
  isTelemetryEnabled,
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
 * separates apps that share one); `launch` is how the visitor reached it:
 * `standalone` through the connect menu, `ehr` through an EHR launch. Further
 * string tags ride along under their own names.
 */
interface TelemetryTags {
  readonly app: string
  readonly launch?: 'standalone' | 'ehr'
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
 * The `Sentry.init` options that hold the SDK to what `consent` allows.
 *
 * @remarks
 * {@link PERSONAL_DATA_OFF} applies whatever the answer. Browser tracing is added only
 * with `performance`; nothing adds session replay or profiling. Each hook
 * drops the events its switch does not cover — error events without
 * `crashReports`, transactions without `performance` — and anonymizes the URLs
 * in the ones it sends.
 */
const sentryOptionsFor = (consent: TelemetryConsent): InitSentryWebOptions => ({
  dataCollection: PERSONAL_DATA_OFF,
  integrations: consent.performance ? [Sentry.browserTracingIntegration()] : [],
  beforeSend: (errorEvent) => (consent.crashReports ? scrubEvent(errorEvent) : null),
  beforeSendTransaction: (transactionEvent) =>
    consent.performance ? scrubEvent(transactionEvent) : null,
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
 * derives from `consent`.
 *
 * Idempotent like {@link initWebTelemetry}: once the SDK is initialized, later
 * calls keep its first options, so a changed answer takes effect on the next
 * page load.
 */
const initConsentedTelemetry = ({
  consent,
  config,
  tags,
}: InitConsentedTelemetryOptions): boolean => {
  const consentedConfig = telemetryConfigFor(consent, config)
  if (consent === undefined || !isTelemetryEnabled(consentedConfig)) return false
  Sentry.getGlobalScope().setTags(tags)
  initWebTelemetry(consentedConfig, sentryOptionsFor(consent))
  return true
}

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
export { initConsentedTelemetry, setFhirServerHost }
