import type { BrowserOptions, ErrorEvent } from '@sentry/react'
import { configFromEnv, type TelemetryConsent } from '@wildflowerhealthio/telemetry-core'
import { Effect, type Layer, type Tracer } from 'effect'
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

const tags = { app: 'medications-web', launch: 'launched' } as const

const consentWith = (switches: {
  readonly crashReports: boolean
  readonly performance: boolean
}): TelemetryConsent => ({ version: 1, decidedAt: '2026-09-29T12:00:00.000Z', ...switches })

const FHIR_URL = 'https://fhir.example/r4/Patient/123?_format=json'
const ANONYMIZED_FHIR_URL = 'https://{host}/r4/Patient/{id}'

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

describe('server host redaction', () => {
  /** An error event thrown from `scriptUrl`, with the debug image the SDK lists for it. */
  const errorEventThrownFrom = (scriptUrl: string): ErrorEvent => ({
    type: undefined,
    exception: { values: [{ type: 'Error', stacktrace: { frames: [{ filename: scriptUrl }] } }] },
    debug_meta: { images: [{ type: 'sourcemap', code_file: scriptUrl, debug_id: 'd1' }] },
  })

  /** The script URL of the one frame, and the code file of the one debug image, `event` sends. */
  const sentScriptUrls = (event: ErrorEvent | null | undefined): readonly unknown[] => [
    event?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename,
    event?.debug_meta?.images?.[0]?.code_file,
  ]

  const startCrashReports = async (): Promise<typeof Consented> => {
    const consented = await importConsented()
    consented.initConsentedTelemetry({
      consent: consentWith({ crashReports: true, performance: false }),
      config: buildConfig,
      tags,
    })
    return consented
  }

  test.each([
    { case: 'a host it was told to redact', redact: 'ruth.example', host: 'Ruth.Example:8443' },
    { case: 'the FHIR server’s host', fhirServerHost: 'fhir.example:8443', host: 'fhir.example' },
    { case: 'a relay tunnel', host: 'android-emu.relay.wildflowerhealth.io' },
  ])('replaces $case in a stack frame, keeping the script’s path', async (example) => {
    const { redactServerHost, setFhirServerHost } = await startCrashReports()
    if (example.redact !== undefined) redactServerHost(example.redact)
    if (example.fhirServerHost !== undefined) setFhirServerHost(example.fhirServerHost)

    const sent = await sentryInitOptions().beforeSend?.(
      errorEventThrownFrom(`https://${example.host}/assets/index-abc.js`),
      {}
    )

    expect(sentScriptUrls(sent)).toStrictEqual([
      'https://{host}/assets/index-abc.js',
      'https://{host}/assets/index-abc.js',
    ])
  })

  test('replaces a server host in an error’s message and a transaction’s name', async () => {
    const { initConsentedTelemetry, redactServerHost } = await importConsented()
    initConsentedTelemetry({
      consent: consentWith({ crashReports: true, performance: true }),
      config: buildConfig,
      tags,
    })
    redactServerHost('ruth.example')
    const options = sentryInitOptions()

    const sentError = await options.beforeSend?.(
      {
        type: undefined,
        exception: { values: [{ type: 'Error', value: 'ruth.example is down' }] },
      },
      {}
    )
    const sentTransaction = await options.beforeSendTransaction?.(
      { type: 'transaction', transaction: 'connect Ruth.Example:8443' },
      {}
    )

    expect(sentError?.exception?.values?.[0]?.value).toBe('{host} is down')
    expect(sentTransaction?.transaction).toBe('connect {host}')
  })

  test('replaces the page’s own host in a stack frame', async () => {
    vi.stubGlobal('location', { host: 'my-server.example' })
    try {
      await startCrashReports()

      const sent = await sentryInitOptions().beforeSend?.(
        errorEventThrownFrom('https://my-server.example/launcher/assets/index-abc.js'),
        {}
      )

      expect(sentScriptUrls(sent)).toStrictEqual([
        'https://{host}/launcher/assets/index-abc.js',
        'https://{host}/launcher/assets/index-abc.js',
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test.each([
    'https://wildflowerhealth.io/launcher/assets/index-abc.js',
    'https://other.example/assets/index-abc.js',
  ])('keeps a stack frame on %s, a kept host or one it was not told about', async (scriptUrl) => {
    await startCrashReports()

    const sent = await sentryInitOptions().beforeSend?.(errorEventThrownFrom(scriptUrl), {})

    expect(sentScriptUrls(sent)).toStrictEqual([scriptUrl, scriptUrl])
  })
})

describe('setFhirServerHost', () => {
  test.each([
    { case: 'a host', host: 'fhir.example:8443', tag: '{host}' },
    { case: 'a kept host', host: 'localhost:8080', tag: 'localhost:8080' },
    { case: 'an empty host', host: '', tag: '{empty}' },
    { case: 'no host (null)', host: null, tag: '{null}' },
    { case: 'no host (undefined)', host: undefined, tag: '{null}' },
  ])('tags later events with $case as $tag', async ({ host, tag }) => {
    const { setFhirServerHost } = await importConsented()

    setFhirServerHost(host)

    expect(setTagMock).toHaveBeenCalledExactlyOnceWith('fhir_server_host', tag)
  })

  test('sets no tag while it is not called', async () => {
    const { initConsentedTelemetry } = await importConsented()

    initConsentedTelemetry({
      consent: consentWith({ crashReports: true, performance: false }),
      config: buildConfig,
      tags,
    })

    expect(setTagMock).not.toHaveBeenCalled()
  })
})

describe('consentedTelemetryLayer', () => {
  /** The tracer an effect runs with under `layer`. */
  const tracerUnder = (layer: Layer.Layer<never>): Tracer.Tracer =>
    Effect.runSync(Effect.provide(Effect.tracer, layer))

  const defaultTracer = Effect.runSync(Effect.tracer)

  test('leaves Effect on its default tracer, and starts nothing, before any answer', async () => {
    const { consentedTelemetryLayer } = await importConsented()

    expect(tracerUnder(consentedTelemetryLayer)).toBe(defaultTracer)
    expect(initMock).not.toHaveBeenCalled()
  })

  test('binds Effect to the registered tracer provider once performance is on', async () => {
    const { consentedTelemetryLayer, initConsentedTelemetry } = await importConsented()

    initConsentedTelemetry({
      consent: consentWith({ crashReports: false, performance: true }),
      config: buildConfig,
      tags,
    })

    expect(tracerUnder(consentedTelemetryLayer)).not.toBe(defaultTracer)
  })

  test('leaves Effect on its default tracer when only crash reports are on', async () => {
    const { consentedTelemetryLayer, initConsentedTelemetry } = await importConsented()

    initConsentedTelemetry({
      consent: consentWith({ crashReports: true, performance: false }),
      config: buildConfig,
      tags,
    })

    expect(initMock).toHaveBeenCalledTimes(1)
    expect(tracerUnder(consentedTelemetryLayer)).toBe(defaultTracer)
  })

  test('follows the latest answer each time it is built', async () => {
    const { consentedTelemetryLayer, initConsentedTelemetry } = await importConsented()
    initConsentedTelemetry({
      consent: consentWith({ crashReports: true, performance: true }),
      config: buildConfig,
      tags,
    })
    expect(tracerUnder(consentedTelemetryLayer)).not.toBe(defaultTracer)

    initConsentedTelemetry({
      consent: consentWith({ crashReports: true, performance: false }),
      config: buildConfig,
      tags,
    })

    expect(tracerUnder(consentedTelemetryLayer)).toBe(defaultTracer)
  })

  test('stays empty when a yes registers no tracer provider (no DSN in the build)', async () => {
    const { consentedTelemetryLayer, initConsentedTelemetry } = await importConsented()

    initConsentedTelemetry({
      consent: consentWith({ crashReports: true, performance: true }),
      config: configFromEnv({}),
      tags,
    })

    expect(tracerUnder(consentedTelemetryLayer)).toBe(defaultTracer)
  })
})
