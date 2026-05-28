import { act, renderHook, waitFor } from '@testing-library/react'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { useComponentScopedRunner } from './use-component-scoped-runner.ts'

type Fixture = {
  arg: Layer.Layer<never> | Effect.Effect<never>
  getActive: () => number
}

const makeCountingLayer = (): Fixture => {
  let active = 0
  const arg = Layer.scopedDiscard(
    Effect.acquireRelease(
      Effect.sync(() => {
        active += 1
      }),
      () =>
        Effect.sync(() => {
          active -= 1
        })
    )
  )
  return { arg, getActive: (): number => active }
}

const makeCountingEffect = (): Fixture => {
  let active = 0
  const arg = Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(() => {
        active += 1
      }),
      () =>
        Effect.sync(() => {
          active -= 1
        })
    ).pipe(Effect.andThen(Effect.never))
  )
  return { arg, getActive: (): number => active }
}

describe.each([
  ['Layer', makeCountingLayer],
  ['Effect', makeCountingEffect],
] as const)('useComponentScopedRunner with a %s', (_label, makeFixture) => {
  it('runs on mount', async () => {
    const { arg, getActive } = makeFixture()
    renderHook(() => {
      useComponentScopedRunner(arg)
    })
    await waitFor(() => expect(getActive()).toBe(1))
  })

  it('interrupts the forked fiber on unmount', async () => {
    const { arg, getActive } = makeFixture()
    const { unmount } = renderHook(() => {
      useComponentScopedRunner(arg)
    })
    await waitFor(() => expect(getActive()).toBe(1))
    unmount()
    await waitFor(() => expect(getActive()).toBe(0))
  })

  it('survives an unmount → remount cycle without leaking an active fiber', async () => {
    const { arg, getActive } = makeFixture()
    const first = renderHook(() => {
      useComponentScopedRunner(arg)
    })
    await waitFor(() => expect(getActive()).toBe(1))
    first.unmount()
    await waitFor(() => expect(getActive()).toBe(0))
    renderHook(() => {
      useComponentScopedRunner(arg)
    })
    await waitFor(() => expect(getActive()).toBe(1))
  })

  it('does not re-run when the arg reference is stable across renders', async () => {
    const { arg, getActive } = makeFixture()
    const { rerender } = renderHook(() => {
      useComponentScopedRunner(arg)
    })
    await waitFor(() => expect(getActive()).toBe(1))
    await act(async () => {
      rerender()
    })
    expect(getActive()).toBe(1)
  })
})
