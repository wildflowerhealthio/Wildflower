import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { PatientChoiceLine } from './patient-choice-line.tsx'
import type { PatientChoice } from './patient-choice.ts'
import { answer, type FhirResponses, stubSmartClient } from './smart-client.test-helpers.ts'

/** Render the line for `patientChoice` over `responses`; returns its change handler and requests. */
const renderLine = (
  patientChoice: PatientChoice,
  responses: FhirResponses
): {
  readonly onPatientChange: ReturnType<typeof vi.fn<() => void>>
  readonly requests: readonly string[]
} => {
  const onPatientChange = vi.fn<() => void>()
  const { client, requests } = stubSmartClient(responses)
  render(
    <StrictMode>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <PatientChoiceLine
          client={client}
          patientChoice={patientChoice}
          onPatientChange={onPatientChange}
        />
      </QueryClientProvider>
    </StrictMode>
  )
  return { onPatientChange, requests }
}

afterEach(() => {
  cleanup()
})

describe('PatientChoiceLine', () => {
  it('should name the patient chosen, with their birth date', async () => {
    // Act
    renderLine(
      { kind: 'patient', patientId: 'p1' },
      {
        'Patient/p1': answer({
          resourceType: 'Patient',
          id: 'p1',
          name: [{ given: ['Ada'], family: 'Lovelace' }],
          birthDate: '1815-12-10',
        }),
      }
    )

    // Assert
    expect(await screen.findByText('Ada Lovelace · born 1815-12-10')).toBeDefined()
  })

  it('should say All patients for every patient, reading none', () => {
    // Act
    const { requests } = renderLine({ kind: 'all-patients' }, {})

    // Assert
    expect(screen.getByText('All patients')).toBeDefined()
    expect(requests).toEqual([])
  })

  it('should go back to the picker on Change patient', () => {
    // Arrange
    const { onPatientChange } = renderLine({ kind: 'all-patients' }, {})

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Change patient' }))

    // Assert
    expect(onPatientChange).toHaveBeenCalledOnce()
  })

  it('should say the patient could not be read, and still offer the change', async () => {
    // Act
    renderLine(
      { kind: 'patient', patientId: 'p1' },
      { 'Patient/p1': answer({ resourceType: 'Bundle' }) }
    )

    // Assert
    expect(await screen.findByText('Could not load patient p1: not a FHIR Patient')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Change patient' })).toBeDefined()
  })
})
