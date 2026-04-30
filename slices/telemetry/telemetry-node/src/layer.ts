import { Resource, Tracer as OtelEffectTracer } from '@effect/opentelemetry'
import { trace, type Tracer } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BatchSpanProcessor, type Sampler, type SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { SentryPropagator, SentrySampler, SentrySpanProcessor } from '@sentry/opentelemetry'
import { Layer } from 'effect'
import { isOtlpEnabled, isTelemetryEnabled, type TelemetryConfig } from 'telemetry-core'
import { markOtelProviderRegistered } from 'telemetry-core/livestore'
import { initSentryNode, Sentry } from './sentry.ts'

let registered: NodeTracerProvider | undefined

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

const resolveSampler = (sentryOn: boolean): Sampler | undefined => {
  if (!sentryOn) return undefined
  const client = Sentry.getClient()
  if (client === undefined) return undefined
  return new SentrySampler(client)
}

const registerShutdownHandlers = (provider: NodeTracerProvider, sentryOn: boolean): void => {
  const shutdown = async (): Promise<void> => {
    await provider.forceFlush().catch(() => undefined)
    await provider.shutdown().catch(() => undefined)
    if (sentryOn) {
      await Sentry.close(2000).catch(() => undefined)
    }
  }
  const handler = (): void => void shutdown()
  process.on('SIGTERM', handler)
  process.on('SIGINT', handler)
}

/**
 * Eagerly initialize Sentry and register a global OpenTelemetry tracer
 * provider. Safe to call before the Effect runtime starts so Livestore and
 * other direct `@opentelemetry/api` consumers see the provider immediately.
 * Returns `undefined` when no telemetry sinks are configured.
 */
const initNodeTelemetry = (config: TelemetryConfig): NodeTracerProvider | undefined => {
  if (registered !== undefined) return registered
  if (!isTelemetryEnabled(config)) return undefined

  const sentryOn = initSentryNode(config)
  const processors = buildProcessors(config, sentryOn)
  if (processors.length === 0) return undefined

  const sampler = resolveSampler(sentryOn)
  const providerConfig: ConstructorParameters<typeof NodeTracerProvider>[0] = {
    spanProcessors: processors,
  }
  if (sampler !== undefined) providerConfig.sampler = sampler
  const provider = new NodeTracerProvider(providerConfig)

  const registerConfig: Parameters<NodeTracerProvider['register']>[0] = {}
  if (sentryOn) registerConfig.propagator = new SentryPropagator()
  provider.register(registerConfig)
  markOtelProviderRegistered()

  registerShutdownHandlers(provider, sentryOn)

  registered = provider
  return provider
}

/**
 * Effect Layer that binds Effect's tracing to whatever tracer provider is
 * registered globally (see `initNodeTelemetry`). The layer is a no-op when
 * telemetry is disabled so callers can provide it unconditionally.
 */
const makeNodeTelemetryLayer = (
  config: TelemetryConfig
):
  | Layer.Layer<OtelEffectTracer.OtelTracer | Resource.Resource, never, never>
  | Layer.Layer<never, never, never> => {
  const provider = initNodeTelemetry(config)
  if (provider === undefined) return Layer.empty
  const ResourceLive = Resource.layer({
    serviceName: config.otel.serviceName,
    serviceVersion: config.otel.serviceVersion,
  })
  return Layer.provideMerge(OtelEffectTracer.layerGlobal, ResourceLive)
}

/** Returns the globally registered tracer, or a no-op tracer if unset. */
const getGlobalTracer = (name: string): Tracer => trace.getTracer(name)

export { getGlobalTracer, initNodeTelemetry, makeNodeTelemetryLayer }
