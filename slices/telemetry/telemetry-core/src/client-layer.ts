import * as Resource from '@effect/opentelemetry/Resource'
import * as OtelEffectTracer from '@effect/opentelemetry/Tracer'
import { context, type ContextManager, propagation, trace, type Tracer } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type Sampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { SentryPropagator, SentrySampler, SentrySpanProcessor } from '@sentry/opentelemetry'
import { Layer } from 'effect'
import { isOtlpEnabled, isTelemetryEnabled, type TelemetryConfig } from './config.ts'
import { markOtelInitAttempted, markOtelProviderRegistered } from './otel-guard.ts'

type SentryClient = ConstructorParameters<typeof SentrySampler>[0]

interface SentryAdapter {
  readonly init: (config: TelemetryConfig) => boolean
  readonly getClient: () => SentryClient | undefined
}

/**
 * Builds the platform's synchronous OTel `ContextManager`.
 *
 * @remarks
 * Supplied by the platform adapter (`telemetry-web` passes
 * `() => new StackContextManager()` from `@opentelemetry/sdk-trace-web`)
 * so this package stays free of platform-specific OTel SDKs. Called at
 * most once: the first manager built is installed globally and every
 * later {@link initClientTelemetry} call reuses it.
 */
type ContextManagerFactory = () => ContextManager

let registered: BasicTracerProvider | undefined
let contextManagerInstalled = false

/**
 * Install the platform's synchronous OTel `ContextManager` globally.
 *
 * @param createContextManager - Builds the manager; not called once one is installed
 *
 * @remarks
 * Required even when no exporters are configured:
 * `@effect/opentelemetry`'s per-fiber-step `otel.context.with(ctx, fn)`
 * bridge depends on a real ContextManager to round-trip context around
 * `fn()`. Without one (i.e. the default `NoopContextManager`) the bridge
 * interaction with Effect's runtime breaks (historically
 * `Not a valid effect: {}` on Hermes/React Native). Idempotent —
 * safe to call repeatedly.
 */
const installContextManager = (createContextManager: ContextManagerFactory): void => {
  if (contextManagerInstalled) return
  const contextManager = createContextManager()
  contextManager.enable()
  context.setGlobalContextManager(contextManager)
  contextManagerInstalled = true
}

const buildProcessors = (config: TelemetryConfig, sentryOn: boolean): SpanProcessor[] => {
  const processors: SpanProcessor[] = []
  if (sentryOn) processors.push(new SentrySpanProcessor())
  if (isOtlpEnabled(config)) {
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: config.otel.otlpEndpoint,
          headers: config.otel.otlpHeaders ?? undefined,
        })
      )
    )
  }
  return processors
}

const resolveSampler = (
  sentryOn: boolean,
  getClient: SentryAdapter['getClient']
): Sampler | undefined => {
  if (!sentryOn) return undefined
  const client = getClient()
  if (client === undefined) return undefined
  return new SentrySampler(client)
}

/**
 * Eagerly initialize Sentry (via the provided adapter) and register a global
 * OpenTelemetry tracer provider. Safe to call before any other consumers of
 * `@opentelemetry/api` so they pick up the provider immediately.
 *
 * @param createContextManager - Builds the platform's synchronous `ContextManager`
 * @returns The registered provider, or `undefined` when no telemetry sinks are configured
 */
const initClientTelemetry = (
  config: TelemetryConfig,
  sentry: SentryAdapter,
  createContextManager: ContextManagerFactory
): BasicTracerProvider | undefined => {
  if (registered !== undefined) return registered

  // Install the synchronous ContextManager up-front so the
  // `@effect/opentelemetry` bridge has a real context to bind into even
  // when no exporters are configured. See `installContextManager` for
  // the load-bearing reason.
  installContextManager(createContextManager)

  // Always invoke the Sentry adapter so unconditional `Sentry.wrap`
  // calls in app entry points don't trigger "wrap before init" warnings.
  // Adapters no-op (or initialize in disabled mode) when no DSN is set.
  const sentryOn = sentry.init(config)

  if (!isTelemetryEnabled(config)) {
    markOtelInitAttempted()
    return undefined
  }
  const processors = buildProcessors(config, sentryOn)
  if (processors.length === 0) {
    markOtelInitAttempted()
    return undefined
  }

  const sampler = resolveSampler(sentryOn, sentry.getClient)
  const providerConfig: ConstructorParameters<typeof BasicTracerProvider>[0] = {
    spanProcessors: processors,
  }
  if (sampler !== undefined) providerConfig.sampler = sampler
  const provider = new BasicTracerProvider(providerConfig)

  trace.setGlobalTracerProvider(provider)
  if (sentryOn) propagation.setGlobalPropagator(new SentryPropagator())
  markOtelProviderRegistered()

  registered = provider
  return provider
}

/**
 * Effect Layer that binds Effect's tracing to whatever tracer provider is
 * registered globally (see {@link initClientTelemetry}). The layer is a no-op
 * when telemetry is disabled so callers can provide it unconditionally.
 *
 * @param createContextManager - Builds the platform's synchronous `ContextManager`
 */
const makeClientTelemetryLayer = (
  config: TelemetryConfig,
  sentry: SentryAdapter,
  createContextManager: ContextManagerFactory
):
  | Layer.Layer<OtelEffectTracer.OtelTracer | Resource.Resource, never, never>
  | Layer.Layer<never, never, never> => {
  const provider = initClientTelemetry(config, sentry, createContextManager)
  if (provider === undefined) return Layer.empty
  const ResourceLive = Resource.layer({
    serviceName: config.otel.serviceName,
    serviceVersion: config.otel.serviceVersion,
  })
  return Layer.provideMerge(OtelEffectTracer.layerGlobal, ResourceLive)
}

/** Returns the globally registered tracer, or a no-op tracer if unset. */
const getGlobalTracer = (name: string): Tracer => trace.getTracer(name)

export type { ContextManagerFactory, SentryAdapter, SentryClient }
export { getGlobalTracer, initClientTelemetry, makeClientTelemetryLayer }
