import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { unwrapFiberFailure } from './unwrap-fiber-failure.ts'

/** Run an effect and capture the `FiberFailure` its promise rejects with. */
const rejectionOf = async (effect: Effect.Effect<never, unknown>): Promise<unknown> => {
  try {
    await Effect.runPromise(effect)
    throw new Error('expected the effect to reject')
  } catch (caught: unknown) {
    return caught
  }
}

describe('unwrapFiberFailure', () => {
  it('returns a non-FiberFailure value unchanged', () => {
    const error = new Error('plain')
    expect(unwrapFiberFailure(error)).toBe(error)
    expect(unwrapFiberFailure('a string')).toBe('a string')
    expect(unwrapFiberFailure(null)).toBeNull()
  })

  it('unwraps a typed failure (the failure channel) out of the FiberFailure', async () => {
    const failure = { _tag: 'MyError', detail: 42 } as const
    const caught = await rejectionOf(Effect.fail(failure))
    // The raw rejection is the opaque FiberFailure, not the typed error…
    expect(caught).not.toBe(failure)
    // …which unwraps back to the value that was `fail`ed.
    expect(unwrapFiberFailure(caught)).toBe(failure)
  })

  it('unwraps a defect (a die/thrown value) when there is no typed failure', async () => {
    const defect = new Error('boom')
    const caught = await rejectionOf(Effect.die(defect))
    expect(unwrapFiberFailure(caught)).toBe(defect)
  })
})
