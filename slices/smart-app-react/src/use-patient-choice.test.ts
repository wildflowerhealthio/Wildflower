import { act, renderHook } from '@testing-library/react'
import { Option } from 'effect'
import { beforeEach, describe, expect, it } from 'vite-plus/test'

import { usePatientChoice } from './use-patient-choice.ts'

/** The hook's one input, as `renderHook` props. */
interface LaunchPatient {
  readonly launchPatientId: string | null
}

const patientParamInUrl = (): string | null =>
  new URLSearchParams(window.location.search).get('patient')

beforeEach(() => {
  window.history.replaceState(null, '', '/app/')
})

describe('usePatientChoice', () => {
  it("opens on the launch's patient when the URL names none, and leaves the URL alone", () => {
    // Arrange — an OAuth callback's query, which must survive the mount
    window.history.replaceState(null, '', '/app/?code=abc&state=xyz')

    // Act
    const { result } = renderHook(() => usePatientChoice('p-launch'))

    // Assert
    expect(result.current.patientChoice).toEqual(
      Option.some({ kind: 'patient', patientId: 'p-launch' })
    )
    expect(window.location.search).toBe('?code=abc&state=xyz')
  })

  it("opens on the URL's choice over the launch's patient", () => {
    // Arrange
    window.history.replaceState(null, '', '/app/?patient=*')

    // Act
    const { result } = renderHook(() => usePatientChoice('p-launch'))

    // Assert
    expect(result.current.patientChoice).toEqual(Option.some({ kind: 'all-patients' }))
  })

  it('has no choice with neither a URL choice nor a launch patient', () => {
    // Act
    const { result } = renderHook(() => usePatientChoice(null))

    // Assert
    expect(result.current.patientChoice).toEqual(Option.none())
  })

  it("takes up the launch's patient once the handshake hands it over", () => {
    // Arrange — no patient while the handshake is still connecting
    const connecting: LaunchPatient = { launchPatientId: null }
    const { result, rerender } = renderHook(
      ({ launchPatientId }: LaunchPatient) => usePatientChoice(launchPatientId),
      { initialProps: connecting }
    )

    // Act
    rerender({ launchPatientId: 'p-launch' })

    // Assert
    expect(result.current.patientChoice).toEqual(
      Option.some({ kind: 'patient', patientId: 'p-launch' })
    )
  })

  it('writes a choice to the URL beside the query keys already there', () => {
    // Arrange
    window.history.replaceState(null, '', '/app/?r=1y&s=o:x')
    const { result } = renderHook(() => usePatientChoice(null))

    // Act
    act(() => {
      result.current.choosePatient({ kind: 'patient', patientId: 'p2' })
    })

    // Assert
    expect(result.current.patientChoice).toEqual(Option.some({ kind: 'patient', patientId: 'p2' }))
    expect(window.location.search).toBe('?r=1y&s=o%3Ax&patient=p2')
  })

  it('reopens the picker on a change, keeping the last choice in the URL until another is made', () => {
    // Arrange
    const { result } = renderHook(() => usePatientChoice('p-launch'))

    // Act — change, then choose every patient
    act(() => {
      result.current.changePatient()
    })

    // Assert — choosing, with the URL untouched
    expect(result.current.patientChoice).toEqual(Option.none())
    expect(patientParamInUrl()).toBeNull()

    // Act
    act(() => {
      result.current.choosePatient({ kind: 'all-patients' })
    })

    // Assert
    expect(result.current.patientChoice).toEqual(Option.some({ kind: 'all-patients' }))
    expect(patientParamInUrl()).toBe('*')
  })
})
