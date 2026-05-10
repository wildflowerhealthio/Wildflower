import { Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import * as LoggingLayerTest from './logging-layer-test.ts'

describe('LoggingLayerTest', () => {
  test('expectToLog captures Effect.logWarning into the sink at WARN level', async () => {
    await Effect.runPromise(
      Effect.logWarning('hello world').pipe(
        LoggingLayerTest.expectToLog((logs) => {
          const warn = logs.find((entry) => entry.level === 'WARN')
          expect(warn).toBeDefined()
          expect(warn?.message).toContain('hello world')
        }),
        Effect.scoped
      )
    )
  })
})
