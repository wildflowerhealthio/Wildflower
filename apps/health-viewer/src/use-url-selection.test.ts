import { act, renderHook } from '@testing-library/react'
import { SERIES_PARAM, decodeSelection } from 'health-viewer-core'
import { beforeEach, describe, expect, it } from 'vite-plus/test'

import { useUrlSelection } from './use-url-selection.ts'

const selectionInUrl = (): ReturnType<typeof decodeSelection> =>
  decodeSelection(new URLSearchParams(window.location.search))

beforeEach(() => {
  window.history.replaceState(null, '', '/health-viewer-app/')
})

describe('useUrlSelection', () => {
  it('opens on the selection the URL carries, and leaves the URL alone until it changes', () => {
    // Arrange — an OAuth callback's query, which must survive the mount
    window.history.replaceState(null, '', `/health-viewer-app/?code=abc&r=1y&${SERIES_PARAM}=o:x`)

    // Act
    const { result } = renderHook(() => useUrlSelection())

    // Assert
    expect(result.current.selection.range).toBe('1y')
    expect(window.location.search).toBe(`?code=abc&r=1y&${SERIES_PARAM}=o:x`)
  })

  it('lands both of two updates made before a re-render, and writes the result to the URL', () => {
    // Arrange
    const { result } = renderHook(() => useUrlSelection())
    const { updateSelection } = result.current

    // Act — both updates are issued from the same render
    act(() => {
      updateSelection((latest) => ({ ...latest, range: '90d' }))
      updateSelection((latest) => ({ ...latest, patient: 'p1' }))
    })

    // Assert — neither overwrote the other, in state or in the URL
    const expected = { series: [], range: '90d', patient: 'p1' }
    expect(result.current.selection).toEqual(expected)
    expect(selectionInUrl()).toEqual(expected)
  })
})
