import { render } from '@testing-library/react'
import CollectorBridge from 'collector-fundamentals/bridge'
import { Effect, Layer } from 'effect'
import { BareSender } from 'effect-messaging-core'
import { useContext, type JSX, type ReactNode } from 'react'
import { describe, expect, it } from 'vite-plus/test'

/** Stub `BareSender` for direct handler invocation. */
const noopBareSenderLayer = Layer.succeed(BareSender, { bareSender: () => Effect.void })

import {
  CollectorRuntimeContext,
  type CollectorRuntimeContextValue,
} from '../src/runtime/collector-runtime-context.ts'
import { CollectorRuntimeProvider } from '../src/runtime/collector-runtime-provider.tsx'

/**
 * Render the provider with a probe child that captures the context
 * value into a ref-style box. Returns the captured value (typed
 * non-null since the probe pushes during the synchronous mount).
 */
const captureContextValue = (): CollectorRuntimeContextValue => {
  const box: { value: CollectorRuntimeContextValue | null } = { value: null }
  const Probe = (): null => {
    const value = useContext(CollectorRuntimeContext)
    if (value !== null) box.value = value
    return null
  }
  const tree: ReactNode = (
    <CollectorRuntimeProvider>
      <Probe />
    </CollectorRuntimeProvider>
  )
  render(tree as JSX.Element)
  if (box.value === null) {
    throw new Error('expected the CollectorRuntimeProvider to publish a context value')
  }
  return box.value
}

describe('CollectorRuntimeProvider', () => {
  it('exposes a setActiveHandler function on the context value', () => {
    const value = captureContextValue()
    expect(typeof value.setActiveHandler).toBe('function')
  })

  it('exposes a prebuilt receiverLayer for the CollectorBridge Web tag', () => {
    const value = captureContextValue()
    // The layer's existence + the fact that it satisfies the
    // `CollectorBridge.Web.HandlerTag` requirement is the load-bearing
    // invariant: the app's TransportProvider composes this layer with
    // the rest of the bridge stack. We confirm the resulting Effect
    // type-checks against the tag's `Service` shape.
    expect(value.receiverLayer).toBeDefined()
  })

  it('log-and-drops each Host-to-Web tag dispatch when no handler is installed', async () => {
    const value = captureContextValue()

    // Resolve the tag service through the layer and invoke each
    // handler with a fake event. The drop path is `Effect.logWarning`
    // followed by `void` — none should throw or fail.
    const program = Effect.gen(function* () {
      const service = yield* CollectorBridge.Web.HandlerTag
      yield* service.ResponseStart({
        _tag: 'ResponseStart',
        id: '1',
        url: 'https://example.test',
        status: 200,
        statusText: 'OK',
        headers: [],
      })
      yield* service.ResponseData({ _tag: 'ResponseData', id: '1', data: 'AAA=' })
      yield* service.ResponseFinished({ _tag: 'ResponseFinished', id: '1' })
      yield* service.RequestError({
        _tag: 'RequestError',
        id: '1',
        url: 'https://example.test',
        message: 'boom',
      })
      yield* service.Cancelled({ _tag: 'Cancelled', id: '1' })
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(Layer.merge(value.receiverLayer, noopBareSenderLayer)))
    )
  })
})
