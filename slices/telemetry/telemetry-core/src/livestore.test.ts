import { context as otelContext } from '@opentelemetry/api'
import { describe, expect, test } from 'vite-plus/test'
import {
  getLivestoreOtelOptions,
  injectActiveOtelContext,
  markOtelInitAttempted,
  markOtelProviderRegistered,
  whenOtelProviderReady,
} from './livestore.ts'

interface CallLog {
  query: Array<readonly [unknown, unknown]>
  commit: unknown[][]
  subscribe: unknown[][]
}

interface StubStore {
  query: (q: unknown, options?: Record<string, unknown>) => unknown
  commit: (...args: unknown[]) => unknown
  subscribe: (...args: unknown[]) => unknown
}

const noopFn = (): undefined => undefined

const makeStubStore = (): { store: StubStore; log: CallLog } => {
  const log: CallLog = { query: [], commit: [], subscribe: [] }
  const store: StubStore = {
    query(q, options) {
      log.query.push([q, options])
      return 'query-result'
    },
    commit(...args) {
      log.commit.push(args)
      return 'commit-result'
    },
    subscribe(...args) {
      log.subscribe.push(args)
      return 'subscribe-result'
    },
  }
  return { store, log }
}

describe('injectActiveOtelContext', () => {
  test('returns the same store reference passed in', () => {
    const { store } = makeStubStore()
    expect(injectActiveOtelContext(store)).toBe(store)
  })

  test('idempotent: a second invocation does not re-wrap the methods', () => {
    const { store, log } = makeStubStore()
    injectActiveOtelContext(store)
    injectActiveOtelContext(store)
    store.query('q')
    expect(log.query).toHaveLength(1)
    expect(log.query[0][1]).toMatchObject({ otelContext: otelContext.active() })
  })

  describe('query', () => {
    test('injects the active otel context when options omit it', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)

      store.query('select-foo')

      expect(log.query[0][0]).toBe('select-foo')
      expect(log.query[0][1]).toEqual({ otelContext: otelContext.active() })
    })

    test('preserves a caller-provided otelContext', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      const customCtx = otelContext.active()
      store.query('select-foo', { otelContext: customCtx })

      expect(log.query[0][1]).toEqual({ otelContext: customCtx })
    })

    test('merges otelContext into a caller-provided options bag', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      store.query('select-foo', { label: 'l' })

      expect(log.query[0][1]).toEqual({ label: 'l', otelContext: otelContext.active() })
    })
  })

  describe('commit', () => {
    test('passes a function-form transaction through untouched', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      store.commit(noopFn)

      expect(log.commit[0]).toEqual([noopFn])
    })

    test('wraps a plain event in a fresh options bag carrying the active context', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      const event = { type: 'create', payload: { id: 1 } }
      store.commit(event)

      expect(log.commit[0]).toEqual([{ otelContext: otelContext.active() }, event])
    })

    test('injects the context into a recognised commit-options bag', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      const event = { type: 'x' }
      store.commit({ label: 'foo', skipRefresh: true }, event)

      expect(log.commit[0]).toEqual([
        { label: 'foo', skipRefresh: true, otelContext: otelContext.active() },
        event,
      ])
    })

    test('preserves an explicit otelContext on a commit-options bag', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      const customCtx = otelContext.active()
      store.commit({ label: 'foo', otelContext: customCtx })

      expect(log.commit[0]).toEqual([{ label: 'foo', otelContext: customCtx }])
    })

    test('passes a zero-arg call through (defensive: livestore short-circuits this)', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      store.commit()

      expect(log.commit[0]).toEqual([])
    })
  })

  describe('subscribe', () => {
    test('passes a one-arg call through unchanged', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      store.subscribe('q')

      expect(log.subscribe[0]).toEqual(['q'])
    })

    test('injects context into the (query, options) form', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      store.subscribe('q', { label: 'live' })

      expect(log.subscribe[0]).toEqual(['q', { label: 'live', otelContext: otelContext.active() }])
    })

    test('preserves an explicit otelContext in the (query, options) form', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      const customCtx = otelContext.active()
      store.subscribe('q', { otelContext: customCtx })

      expect(log.subscribe[0]).toEqual(['q', { otelContext: customCtx }])
    })

    test('synthesises an options arg in the (query, listener) form', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      store.subscribe('q', noopFn)

      expect(log.subscribe[0]).toEqual(['q', noopFn, { otelContext: otelContext.active() }])
    })

    test('merges context into the (query, listener, options) form', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      store.subscribe('q', noopFn, { skipInitial: true })

      expect(log.subscribe[0]).toEqual([
        'q',
        noopFn,
        { skipInitial: true, otelContext: otelContext.active() },
      ])
    })

    test('preserves an explicit otelContext in the listener-form options', () => {
      const { store, log } = makeStubStore()
      injectActiveOtelContext(store)
      const customCtx = otelContext.active()
      store.subscribe('q', noopFn, { otelContext: customCtx })

      expect(log.subscribe[0]).toEqual(['q', noopFn, { otelContext: customCtx }])
    })
  })
})

// These tests share the module-level provider-registered flag and must run in
// source order: the first test asserts the pre-registration state, the next
// flips it, and subsequent tests observe the post-registration state.
describe('OTel provider lifecycle', () => {
  test('getLivestoreOtelOptions returns empty options before registration', () => {
    expect(getLivestoreOtelOptions('svc')).toEqual({})
  })

  test('whenOtelProviderReady is unresolved before registration', async () => {
    const sentinel = Symbol('pending')
    const winner = await Promise.race([
      whenOtelProviderReady(),
      Promise.resolve<typeof sentinel>(sentinel),
    ])
    expect(winner).toBe(sentinel)
  })

  test('markOtelInitAttempted resolves whenOtelProviderReady without unlocking the tracer', async () => {
    markOtelInitAttempted()
    await expect(whenOtelProviderReady()).resolves.toBeUndefined()
    expect(getLivestoreOtelOptions('svc')).toEqual({})
  })

  test('markOtelInitAttempted is idempotent', () => {
    expect(() => {
      markOtelInitAttempted()
    }).not.toThrow()
  })

  test('markOtelProviderRegistered resolves the ready promise and unlocks the tracer', async () => {
    markOtelProviderRegistered()
    await expect(whenOtelProviderReady()).resolves.toBeUndefined()
    const opts = getLivestoreOtelOptions('svc')
    expect(opts.tracer).toBeDefined()
  })

  test('markOtelProviderRegistered is idempotent', () => {
    expect(() => {
      markOtelProviderRegistered()
    }).not.toThrow()
  })
})
