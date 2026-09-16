import {
  context,
  type Context,
  type ContextManager,
  createContextKey,
  ROOT_CONTEXT,
} from '@opentelemetry/api'
import { Layer } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import {
  initClientTelemetry,
  makeClientTelemetryLayer,
  type SentryAdapter,
} from './client-layer.ts'
import { configFromEnv } from './config.ts'

const probeKey = createContextKey('telemetry-core/client-layer.test')

/**
 * A `ContextManager` that stands in for a platform SDK's implementation
 * (`StackContextManager` in the browser). `active()` returns a context only
 * this manager can produce, so reading it back through the global
 * `@opentelemetry/api` accessor proves which instance was installed.
 */
class ProbeContextManager implements ContextManager {
  readonly activeContext: Context = ROOT_CONTEXT.setValue(probeKey, 'probe')
  enabled = false

  active(): Context {
    return this.activeContext
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    _context: Context,
    fn: F,
    _thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return fn(...args)
  }

  bind<T>(_context: Context, target: T): T {
    return target
  }

  enable(): this {
    this.enabled = true
    return this
  }

  disable(): this {
    this.enabled = false
    return this
  }
}

const disabledSentry: SentryAdapter = {
  init: () => false,
  getClient: () => undefined,
}

// These tests share `client-layer`'s module-level `contextManagerInstalled`
// flag and must run in source order: the first installs the manager, the
// rest observe that the install is not repeated.
describe('client ContextManager injection', () => {
  const config = configFromEnv({})
  const manager = new ProbeContextManager()
  let built = 0
  const createContextManager = (): ProbeContextManager => {
    built += 1
    return manager
  }

  test('initClientTelemetry enables and globally installs the injected manager', () => {
    expect(initClientTelemetry(config, disabledSentry, createContextManager)).toBeUndefined()

    expect(built).toBe(1)
    expect(manager.enabled).toBe(true)
    expect(context.active()).toBe(manager.activeContext)
  })

  test('initClientTelemetry does not rebuild the manager on a later call', () => {
    expect(initClientTelemetry(config, disabledSentry, createContextManager)).toBeUndefined()

    expect(built).toBe(1)
  })

  test('makeClientTelemetryLayer is a no-op layer while telemetry is disabled', () => {
    expect(makeClientTelemetryLayer(config, disabledSentry, createContextManager)).toBe(Layer.empty)

    expect(built).toBe(1)
  })
})
