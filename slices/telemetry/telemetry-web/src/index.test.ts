import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { configFromViteEnv } from './index.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('configFromViteEnv', () => {
  test('reads the build’s VITE_-prefixed variables', () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://key@sentry.example/1')
    vi.stubEnv('VITE_SENTRY_ENVIRONMENT', 'preview')
    vi.stubEnv('VITE_SENTRY_RELEASE', 'abc123')

    const config = configFromViteEnv()

    expect(config.sentry.dsn).toBe('https://key@sentry.example/1')
    expect(config.sentry.environment).toBe('preview')
    expect(config.sentry.release).toBe('abc123')
  })

  test('lets overrides replace what the environment says', () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://key@sentry.example/1')
    vi.stubEnv('VITE_SENTRY_ENVIRONMENT', 'preview')

    const config = configFromViteEnv({
      sentry: { dsn: 'https://key@sentry.example/2' },
      otel: { serviceName: 'medications-app' },
    })

    expect(config.sentry.dsn).toBe('https://key@sentry.example/2')
    expect(config.otel.serviceName).toBe('medications-app')
    expect(config.sentry.environment).toBe('preview')
  })

  test('keeps an empty DSN override rather than the build’s shared DSN', () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://key@sentry.example/1')

    const config = configFromViteEnv({ sentry: { dsn: '' } })

    expect(config.sentry.dsn).toBe('')
  })
})
