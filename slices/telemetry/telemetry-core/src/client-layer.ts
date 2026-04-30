import * as Resource from '@effect/opentelemetry/Resource'
import * as OtelEffectTracer from '@effect/opentelemetry/Tracer'
import { context, propagation, trace, type Tracer } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type Sampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { StackContextManager } from '@opentelemetry/sdk-trace-web'
import { SentryPropagator, SentrySampler, SentrySpanProcessor } from '@sentry/opentelemetry'
import { Layer } from 'effect'
import { isOtlpEnabled, isTelemetryEnabled, type TelemetryConfig } from './config.ts'
import { markOtelProviderRegistered } from './livestore.ts'

type SentryClient = ConstructorParameters<typeof SentrySampler>[0]

interface SentryAdapter {
  readonly init: (config: TelemetryConfig) => boolean
  readonly getClient: () => SentryClient | undefined
}

let registered: BasicTracerProvider | undefined

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
 * `@opentelemetry/api` so Livestore picks up the provider immediately. Returns
 * `undefined` when no telemetry sinks are configured.
 */
const initClientTelemetry = (
  config: TelemetryConfig,
  sentry: SentryAdapter
): BasicTracerProvider | undefined => {
  if (registered !== undefined) return registered
  if (!isTelemetryEnabled(config)) return undefined

  const sentryOn = sentry.init(config)
  const processors = buildProcessors(config, sentryOn)
  if (processors.length === 0) return undefined

  const sampler = resolveSampler(sentryOn, sentry.getClient)
  const providerConfig: ConstructorParameters<typeof BasicTracerProvider>[0] = {
    spanProcessors: processors,
  }
  if (sampler !== undefined) providerConfig.sampler = sampler
  const provider = new BasicTracerProvider(providerConfig)

  // Without a ContextManager, `otel.context.active()` always returns
  // ROOT_CONTEXT and `context.with(ctx, fn)` does not store ctx. That breaks
  // `@effect/opentelemetry`'s per-fiber-step `context.with(...)` bridge, and
  // Livestore's per-call `otelContext` wrapper can never link DB spans to an
  // HTTP handler's active span. StackContextManager is synchronous-only, but
  // Effect re-establishes context at the start of every fiber step so that
  // is sufficient here.
  const contextManager = new StackContextManager()
  contextManager.enable()
  context.setGlobalContextManager(contextManager)

  trace.setGlobalTracerProvider(provider)
  if (sentryOn) propagation.setGlobalPropagator(new SentryPropagator())
  markOtelProviderRegistered()

  registered = provider
  return provider
}

/**
 * Effect Layer that binds Effect's tracing to whatever tracer provider is
 * registered globally (see `initClientTelemetry`). The layer is a no-op when
 * telemetry is disabled so callers can provide it unconditionally.
 */
const makeClientTelemetryLayer = (
  config: TelemetryConfig,
  sentry: SentryAdapter
):
  | Layer.Layer<OtelEffectTracer.OtelTracer | Resource.Resource, never, never>
  | Layer.Layer<never, never, never> => {
  const provider = initClientTelemetry(config, sentry)
  if (provider === undefined) return Layer.empty
  const ResourceLive = Resource.layer({
    serviceName: config.otel.serviceName,
    serviceVersion: config.otel.serviceVersion,
  })
  return Layer.provideMerge(OtelEffectTracer.layerGlobal, ResourceLive)
}

/** Returns the globally registered tracer, or a no-op tracer if unset. */
const getGlobalTracer = (name: string): Tracer => trace.getTracer(name)

export type { SentryAdapter, SentryClient }
export { getGlobalTracer, initClientTelemetry, makeClientTelemetryLayer }
