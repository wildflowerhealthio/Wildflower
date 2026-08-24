interface SentryRuntimeConfig {
  readonly dsn: string
  readonly environment: string
  readonly release: string
  readonly tracesSampleRate: number
  readonly profileSessionSampleRate: number
}

interface OtelRuntimeConfig {
  readonly serviceName: string
  readonly serviceVersion: string
  readonly otlpEndpoint: string | null
  readonly otlpHeaders: Readonly<Record<string, string>> | null
}

interface TelemetryConfig {
  readonly sentry: SentryRuntimeConfig
  readonly otel: OtelRuntimeConfig
  readonly debug: boolean
}

interface TelemetryConfigOverrides {
  readonly sentry?: Partial<SentryRuntimeConfig>
  readonly otel?: Partial<OtelRuntimeConfig>
  readonly debug?: boolean
}

const isSentryEnabled = (c: TelemetryConfig): boolean => c.sentry.dsn.length > 0

const isOtlpEnabled = (
  c: TelemetryConfig
): c is TelemetryConfig & { readonly otel: { readonly otlpEndpoint: string } } =>
  c.otel.otlpEndpoint !== null && c.otel.otlpEndpoint.length > 0

const isTelemetryEnabled = (c: TelemetryConfig): boolean => isSentryEnabled(c) || isOtlpEnabled(c)

const parseNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return parsed
}

const emptyToNull = (raw: string | undefined): string | null => {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  return trimmed
}

const configFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  prefix: '' | 'VITE_' = ''
): TelemetryConfig => {
  const p = prefix
  return {
    sentry: {
      dsn: env[`${p}SENTRY_DSN`] ?? '',
      environment: env[`${p}SENTRY_ENVIRONMENT`] ?? 'development',
      release: env[`${p}SENTRY_RELEASE`] ?? '',
      tracesSampleRate: parseNumber(env[`${p}SENTRY_TRACES_SAMPLE_RATE`], 1.0),
      profileSessionSampleRate: parseNumber(
        env[`${p}SENTRY_PROFILE_SESSION_SAMPLE_RATE`],
        parseNumber(env[`${p}SENTRY_PROFILES_SAMPLE_RATE`], 0)
      ),
    },
    otel: {
      serviceName: env[`${p}OTEL_SERVICE_NAME`] ?? 'wildflower',
      serviceVersion: env[`${p}OTEL_SERVICE_VERSION`] ?? '0.0.0',
      otlpEndpoint: emptyToNull(env[`${p}OTEL_EXPORTER_OTLP_ENDPOINT`]),
      otlpHeaders: null,
    },
    debug: env[`${p}OTEL_DEBUG`] === 'true',
  }
}

export type { OtelRuntimeConfig, SentryRuntimeConfig, TelemetryConfig, TelemetryConfigOverrides }
export { configFromEnv, isOtlpEnabled, isSentryEnabled, isTelemetryEnabled }
