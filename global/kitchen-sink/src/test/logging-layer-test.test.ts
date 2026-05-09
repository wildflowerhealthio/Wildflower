import { Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import * as LoggingLayerTest from './logging-layer-test.ts'

describe('LoggingLayerTest', () => {
  test('runScoped captures Effect.logWarning into the sink at WARN level', async () => {
    const { promise, logSink } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        yield* Effect.logWarning('hello world')
      })
    )
    await promise
    const warn = logSink.find((entry) => entry.level === 'WARN')
    expect(warn).toBeDefined()
    expect(warn?.message).toContain('hello world')
  })

  test('expectWarningContaining passes when a matching WARN entry is present', async () => {
    const { promise, logSink } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        yield* Effect.logWarning('hello world')
      })
    )
    await promise
    expect(() => {
      LoggingLayerTest.expectWarningContaining(logSink, 'hello')
    }).not.toThrow()
  })

  test('expectWarningContaining throws when the substring is not found in any WARN entry', async () => {
    const { promise, logSink } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        yield* Effect.logWarning('hello world')
      })
    )
    await promise
    expect(() => {
      LoggingLayerTest.expectWarningContaining(logSink, 'GOODBYE')
    }).toThrow(/GOODBYE/)
  })
})
