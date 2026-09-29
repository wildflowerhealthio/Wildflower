import type { BrowserOptions, ErrorEvent } from '@sentry/react'
import { configFromEnv, type TelemetryConsent } from 'telemetry-core'
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import type * as Consented from './consented.ts'

// The Sentry SDK is the collaborator: the module boundary is where we stub it,
// so each test reads back the options `initConsentedTelemetry` handed
// `Sentry.init` and drives the real hooks in them.
const { initMock, setTagsMock, setTagMock, browserTracingIntegration } = vi.hoisted(() => ({
  initMock: vi.fn<(options: BrowserOptions) => void>(),
  setTagsMock: vi.fn<(tags: Readonly<Record<string, string | undefined>>) => void>(),
  setTagMock: vi.fn<(key: string, value: string) => void>(),
  browserTracingIntegration: { name: 'BrowserTracing', setupOnce: (): void => {} },
}))

vi.mock('@sentry/react', () => ({
  init: initMock,
  getClient: (): undefined => undefined,
  getGlobalScope: () => ({ setTags: setTagsMock, setTag: setTagMock }),
  browserTracingIntegration: () => browserTracingIntegration,
}))

type TransactionEvent = Parameters<NonNullable<BrowserOptions['beforeSendTransaction']>>[0]

const buildConfig = configFromEnv({
  SENTRY_DSN: 'https://key@sentry.example/1',
  SENTRY_ENVIRONMENT: 'production',
  SENTRY_TRACES_SAMPLE_RATE: '0.5',
  SENTRY_PROFILES_SAMPLE_RATE: '1',
})

const tags = { app: 'medications-app', launch: 'launched' } as const

const consentWith = (switches: {
  readonly crashReports: boolean
  readonly performance: boolean
}): TelemetryConsent => ({ version: 1, decidedAt: '2026-09-29T12:00:00.000Z', ...switches })

const FHIR_URL = 'https://fhir.example/r4/Patient/123?_format=json'
const ANONYMIZED_FHIR_URL = 'https://fhir.example/r4/Patient/{id}'

const errorEvent: ErrorEvent = {
  type: undefined,
  message: 'boom',
  request: { url: FHIR_URL },
  breadcrumbs: [{ category: 'fetch', data: { url: FHIR_URL } }],
}

const transactionEvent: TransactionEvent = {
  type: 'transaction',
  transaction: '/r4/Patient/123',
  spans: [
    {
      span_id: 's1',
      trace_id: 't1',
      start_timestamp: 0,
      op: 'http.client',
      description: `GET ${FHIR_URL}`,
      data: { 'http.url': FHIR_URL },
    },
  ],
}

/** A fresh copy of the module, so the SDK's once-only init state starts clean. */
const importConsented = async (): Promise<typeof Consented> => {
  vi.resetModules()
  return import('./consented.ts')
}

/** The options the single `Sentry.init` call received. */
const sentryInitOptions = (): BrowserOptions => {
  expect(initMock).toHaveBeenCalledTimes(1)
  const [options] = initMock.mock.calls[0] ?? []
  if (options === undefined) throw new Error('Sentry.init was called without options')
  return options
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('initConsentedTelemetry', () => {
  test.each([
    { label: 'undecided', consent: undefined },
    { label: 'declined', consent: consentWith({ crashReports: false, performance: false }) },
  ])('never initializes Sentry when $label', async ({ consent }) => {
    const { initConsentedTelemetry } = await importConsented()

    expect(initConsentedTelemetry({ consent, config: buildConfig, tags })).toBe(false)
    expect(initMock).not.toHaveBeenCalled()
    expect(setTagsMock).not.toHaveBeenCalled()
  })

  test('never initializes Sentry when the build names no DSN', async () => {
    const { initConsentedTelemetry } = await importConsented()

    expect(
      initConsentedTelemetry({
        consent: consentWith({ crashReports: true, performance: true }),
        config: configFromEnv({}),
        tags,
      })
    ).toBe(false)
    expect(initMock).not.toHaveBeenCalled()
  })

  test('initializes Sentry with tracing off for crash reports only', async () => {
    const { initConsentedTelemetry } = await importConsented()

    expect(
      initConsentedTelemetry({
        consent: consentWith({ crashReports: true, performance: false }),
        config: buildConfig,
        tags,
      })
    ).toBe(true)

    const options = sentryInitOptions()
    expect(options.dsn).toBe(buildConfig.sentry.dsn)
    expect(options.tracesSampleRate).toBe(0)
    expect(options.integrations).toStrictEqual([])
    expect(options.dataCollection?.userInfo).toBe(false)
  })

  test('initializes Sentry with browser tracing for both switches', async () => {
    const { initConsentedTelemetry } = await importConsented()

    expect(
      initConsentedTelemetry({
        consent: consentWith({ crashReports: true, performance: true }),
        config: buildConfig,
        tags,
      })
    ).toBe(true)

    const options = sentryInitOptions()
    expect(options.tracesSampleRate).toBe(0.5)
    expect(options.integrations).toStrictEqual([browserTracingIntegration])
  })

  test('sends scrubbed errors and transactions for both switches', async () => {
    const { initConsentedTelemetry } = await importConsented()
    initConsentedTelemetry({
      consent: consentWith({ crashReports: true, performance: true }),
      config: buildConfig,
      tags,
    })
    const options = sentryInitOptions()

    const sentErrorEvent = await options.beforeSend?.(errorEvent, {})
    const sentTransactionEvent = await options.beforeSendTransaction?.(transactionEvent, {})

    expect(sentErrorEvent?.request?.url).toBe(ANONYMIZED_FHIR_URL)
    expect(sentErrorEvent?.breadcrumbs?.[0]?.data?.['url']).toBe(ANONYMIZED_FHIR_URL)
    expect(sentTransactionEvent?.transaction).toBe('/r4/Patient/{id}')
    expect(sentTransactionEvent?.spans?.[0]?.description).toBe(`GET ${ANONYMIZED_FHIR_URL}`)
    expect(sentTransactionEvent?.spans?.[0]?.data['http.url']).toBe(ANONYMIZED_FHIR_URL)
  })

  test('drops transactions for crash reports only', async () => {
    const { initConsentedTelemetry } = await importConsented()
    initConsentedTelemetry({
      consent: consentWith({ crashReports: true, performance: false }),
      config: buildConfig,
      tags,
    })

    expect(await sentryInitOptions().beforeSendTransaction?.(transactionEvent, {})).toBeNull()
  })

  test('drops errors and sends scrubbed transactions for performance only', async () => {
    const { initConsentedTelemetry } = await importConsented()

    expect(
      initConsentedTelemetry({
        consent: consentWith({ crashReports: false, performance: true }),
        config: buildConfig,
        tags,
      })
    ).toBe(true)

    const options = sentryInitOptions()
    expect(options.integrations).toStrictEqual([browserTracingIntegration])
    expect(await options.beforeSend?.(errorEvent, {})).toBeNull()
    const sentTransactionEvent = await options.beforeSendTransaction?.(transactionEvent, {})
    expect(sentTransactionEvent?.transaction).toBe('/r4/Patient/{id}')
  })

  test('stops sending both kinds of event once the visitor turns both switches off', async () => {
    const { initConsentedTelemetry } = await importConsented()
    initConsentedTelemetry({
      consent: consentWith({ crashReports: true, performance: true }),
      config: buildConfig,
      tags,
    })
    const options = sentryInitOptions()

    expect(
      initConsentedTelemetry({
        consent: consentWith({ crashReports: false, performance: false }),
        config: buildConfig,
        tags,
      })
    ).toBe(false)

    expect(await options.beforeSend?.(errorEvent, {})).toBeNull()
    expect(await options.beforeSendTransaction?.(transactionEvent, {})).toBeNull()
  })

  test('starts sending errors once crash reports are turned on after performance only', async () => {
    const { initConsentedTelemetry } = await importConsented()
    initConsentedTelemetry({
      consent: consentWith({ crashReports: false, performance: true }),
      config: buildConfig,
      tags,
    })
    const options = sentryInitOptions()

    initConsentedTelemetry({
      consent: consentWith({ crashReports: true, performance: true }),
      config: buildConfig,
      tags,
    })

    const sentErrorEvent = await options.beforeSend?.(errorEvent, {})
    expect(sentErrorEvent?.request?.url).toBe(ANONYMIZED_FHIR_URL)
  })

  test('sets the tags on the global scope', async () => {
    const { initConsentedTelemetry } = await importConsented()

    initConsentedTelemetry({
      consent: consentWith({ crashReports: true, performance: false }),
      config: buildConfig,
      tags,
    })

    expect(setTagsMock).toHaveBeenCalledWith(tags)
  })

  test('initializes Sentry once across repeated calls', async () => {
    const { initConsentedTelemetry } = await importConsented()
    const consent = consentWith({ crashReports: true, performance: true })

    initConsentedTelemetry({ consent, config: buildConfig, tags })
    initConsentedTelemetry({ consent, config: buildConfig, tags })

    expect(initMock).toHaveBeenCalledTimes(1)
  })
})

describe('setFhirServerHost', () => {
  test('tags later events with the FHIR server host', async () => {
    const { setFhirServerHost } = await importConsented()

    setFhirServerHost('fhir.example:8443')

    expect(setTagMock).toHaveBeenCalledWith('fhir_server_host', 'fhir.example:8443')
  })
})
