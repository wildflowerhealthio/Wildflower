import { render, renderHook } from '@testing-library/react'
import { Effect, Either } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import { memo } from 'react'
import { describe, expect, test } from 'vite-plus/test'
import { useLateBoundSender } from './late-bound-sender.ts'
import type { TestBridges } from './test-utils/test-bridges.ts'

type TestSender = BridgeTransport.MessageSender<TestBridges, 'HostToWeb'>

describe('useLateBoundSender', () => {
  test('reads the ref at send time — a sender registered later is used', async () => {
    const calls: string[] = []
    const senderRef: { current: TestSender } = {
      current: () => Effect.sync(() => calls.push('default')),
    }
    const { result } = renderHook(() => useLateBoundSender(senderRef))

    // Registered after the hook's first render.
    senderRef.current = (message) => Effect.sync(() => calls.push(message._tag))
    await Effect.runPromise(result.current({ _tag: 'HostBackRequested' }))
    expect(calls).toEqual(['HostBackRequested'])
  })

  test('returns an identity-stable function across renders', () => {
    const senderRef: { current: TestSender } = { current: () => Effect.void }
    const { result, rerender } = renderHook(() => useLateBoundSender(senderRef))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  test('mutating senderRef.current does not re-render the memoised consumer', async () => {
    const calls: string[] = []
    const senderRef: { current: TestSender } = {
      current: () => Effect.sync(() => calls.push('default')),
    }

    // Capture the sender from the first render into a ref so even an
    // accidental re-render couldn't swap the closure under us.
    let captureRenderCount = 0
    const capturedSenderRef: { current: TestSender | undefined } = { current: undefined }

    const Capture = memo((): null => {
      captureRenderCount += 1
      const sender = useLateBoundSender(senderRef)
      if (capturedSenderRef.current === undefined) {
        capturedSenderRef.current = sender
      }
      return null
    })
    Capture.displayName = 'Capture'

    const { rerender } = render(<Capture />)
    expect(captureRenderCount).toBe(1)

    // Mutate the ref after first render. The hook reads `.current` at
    // send time via Effect.suspend, so the new sender is picked up
    // without re-rendering Capture.
    senderRef.current = (message) => Effect.sync(() => calls.push(message._tag))

    // Force the parent to re-render — `Capture` is memoised with no
    // props, so React skips it.
    rerender(<Capture />)
    expect(captureRenderCount).toBe(1)

    const captured = capturedSenderRef.current
    if (captured === undefined) throw new Error('capturedSender not set')
    await Effect.runPromise(captured({ _tag: 'HostBackRequested' }))
    expect(calls).toEqual(['HostBackRequested'])
    // And Capture still hasn't re-rendered.
    expect(captureRenderCount).toBe(1)
  })

  test('propagates failures from the underlying sender through the suspend wrapper', async () => {
    // The typed `MessageSender` signature returns `Effect<void>` with no
    // error channel — production senders flatten failures into the outbox
    // pump's defect log. To exercise the suspend wrapper's *runtime*
    // failure propagation we drop a failing thunk in at the test
    // boundary, the same widening the `makeRecordingSender` test util
    // performs (the hook never inspects the inner effect's failure shape).
    const boom = new Error('boom')
    const failingThunk = (): Effect.Effect<never, Error> => Effect.fail(boom)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const failingSender = failingThunk as unknown as TestSender
    const senderRef: { current: TestSender } = { current: failingSender }
    const { result } = renderHook(() => useLateBoundSender(senderRef))

    const either = await Effect.runPromise(
      Effect.either(
        // Widen the result type to admit the runtime failure channel
        // injected via `failingSender` above.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        result.current({ _tag: 'HostBackRequested' }) as unknown as Effect.Effect<void, Error>
      )
    )
    expect(Either.isLeft(either)).toBe(true)
    if (Either.isLeft(either)) {
      expect(either.left).toBe(boom)
    }
  })
})
