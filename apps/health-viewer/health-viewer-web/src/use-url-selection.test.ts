import { act, renderHook } from '@testing-library/react'
import { SERIES_PARAM, decodeSelection } from '@wildflowerhealthio/health-viewer-core-js'
import { beforeEach, describe, expect, it } from 'vite-plus/test'

import { useUrlSelection } from './use-url-selection.ts'

const selectionInUrl = (): ReturnType<typeof decodeSelection> =>
  decodeSelection(new URLSearchParams(window.location.search))

beforeEach(() => {
  window.history.replaceState(null, '', '/health-viewer/')
})

describe('useUrlSelection', () => {
  it('opens on the selection the URL carries, and leaves the URL alone until it changes', () => {
    // Arrange — an OAuth callback's query, which must survive the mount
    window.history.replaceState(null, '', `/health-viewer/?code=abc&r=1y&${SERIES_PARAM}=o:x`)

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

    // Act — both updates are issued from the same render, the second reading the first
    act(() => {
      updateSelection((latest) => ({ ...latest, range: '90d' }))
      updateSelection((latest) => ({ ...latest, range: latest.range === '90d' ? '28d' : '1y' }))
    })

    // Assert — the second saw the first, in state and in the URL
    const expected = { series: [], range: '28d' }
    expect(result.current.selection).toEqual(expected)
    expect(selectionInUrl()).toEqual(expected)
  })

  it("keeps the patient's query key when it writes the selection", () => {
    // Arrange
    window.history.replaceState(null, '', '/health-viewer/?patient=p1&r=1y')
    const { result } = renderHook(() => useUrlSelection())

    // Act
    act(() => {
      result.current.updateSelection((latest) => ({ ...latest, range: '90d' }))
    })

    // Assert
    const params = new URLSearchParams(window.location.search)
    expect(params.get('patient')).toBe('p1')
    expect(params.get('r')).toBe('90d')
  })
})
