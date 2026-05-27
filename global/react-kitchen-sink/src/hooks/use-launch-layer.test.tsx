import { act, renderHook, waitFor } from '@testing-library/react'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { useLaunchLayer } from './use-launch-layer.ts'

const makeCountingLayer = (): { layer: Layer.Layer<never>; getActive: () => number } => {
  let active = 0
  const layer = Layer.scopedDiscard(
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
  return { layer, getActive: (): number => active }
}

describe('useLaunchLayer', () => {
  it('launches the layer on mount', async () => {
    const { layer, getActive } = makeCountingLayer()
    renderHook(() => {
      useLaunchLayer(layer)
    })
    await waitFor(() => expect(getActive()).toBe(1))
  })

  it('interrupts the launched fiber on unmount', async () => {
    const { layer, getActive } = makeCountingLayer()
    const { unmount } = renderHook(() => {
      useLaunchLayer(layer)
    })
    await waitFor(() => expect(getActive()).toBe(1))
    unmount()
    await waitFor(() => expect(getActive()).toBe(0))
  })

  it('survives an unmount → remount cycle without leaking an active fiber', async () => {
    const { layer, getActive } = makeCountingLayer()
    const first = renderHook(() => {
      useLaunchLayer(layer)
    })
    await waitFor(() => expect(getActive()).toBe(1))
    first.unmount()
    await waitFor(() => expect(getActive()).toBe(0))
    renderHook(() => {
      useLaunchLayer(layer)
    })
    await waitFor(() => expect(getActive()).toBe(1))
  })

  it('does not re-launch when the layer reference is stable across renders', async () => {
    const { layer, getActive } = makeCountingLayer()
    const { rerender } = renderHook(() => {
      useLaunchLayer(layer)
    })
    await waitFor(() => expect(getActive()).toBe(1))
    await act(async () => {
      rerender()
    })
    expect(getActive()).toBe(1)
  })
})
