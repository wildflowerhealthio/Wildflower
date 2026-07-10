import { describe, expect, test } from 'vite-plus/test'
import {
  markOtelInitAttempted,
  markOtelProviderRegistered,
  whenOtelProviderReady,
} from './otel-guard.ts'

// These tests share the module-level init-attempted flag and must run in
// source order: the first test asserts the pre-init state, the next flips
// it, and subsequent tests observe the post-init state.
describe('OTel provider lifecycle', () => {
  test('whenOtelProviderReady is unresolved before init', async () => {
    const sentinel = Symbol('pending')
    const winner = await Promise.race([
      whenOtelProviderReady(),
      Promise.resolve<typeof sentinel>(sentinel),
    ])
    expect(winner).toBe(sentinel)
  })

  test('markOtelInitAttempted resolves whenOtelProviderReady', async () => {
    markOtelInitAttempted()
    await expect(whenOtelProviderReady()).resolves.toBeUndefined()
  })

  test('markOtelInitAttempted is idempotent', () => {
    expect(() => {
      markOtelInitAttempted()
    }).not.toThrow()
  })

  test('markOtelProviderRegistered keeps the ready promise resolved', async () => {
    markOtelProviderRegistered()
    await expect(whenOtelProviderReady()).resolves.toBeUndefined()
  })

  test('markOtelProviderRegistered is idempotent', () => {
    expect(() => {
      markOtelProviderRegistered()
    }).not.toThrow()
  })
})
