import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { PatientChoice } from './patient-choice.ts'
import { PatientPicker } from './patient-picker.tsx'
import {
  answer,
  bundleOf,
  type FhirResponses,
  stubSmartClient,
} from './smart-client.test-helpers.ts'

const adaWire = {
  resourceType: 'Patient',
  id: 'p1',
  name: [{ given: ['Ada'], family: 'Lovelace' }],
  birthDate: '1815-12-10',
}
const graceWire = {
  resourceType: 'Patient',
  id: 'p2',
  name: [{ given: ['Grace'], family: 'Hopper' }],
}

const NEXT_PATIENTS = 'https://fhir.example/next/patients'

/** Render the picker over `responses`, under StrictMode, on a retry-free client. */
const renderPicker = (
  responses: FhirResponses
): { readonly onPatientChoice: ReturnType<typeof vi.fn<(choice: PatientChoice) => void>> } => {
  const onPatientChoice = vi.fn<(choice: PatientChoice) => void>()
  const { client } = stubSmartClient(responses)
  render(
    <StrictMode>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <PatientPicker client={client} onPatientChoice={onPatientChoice} />
      </QueryClientProvider>
    </StrictMode>
  )
  return { onPatientChoice }
}

afterEach(() => {
  cleanup()
})

describe('PatientPicker', () => {
  it('should say Loading… until the first page lands', () => {
    // Act
    renderPicker({ 'Patient?': () => new Promise(() => {}) })

    // Assert
    expect(screen.getByText('Loading…')).toBeDefined()
  })

  it('should list each patient by name and birth date, and hand back the one chosen', async () => {
    // Arrange
    const { onPatientChoice } = renderPicker({
      'Patient?': answer(bundleOf([adaWire, graceWire])),
    })

    // Act
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))

    // Assert
    expect(screen.getByText('born 1815-12-10')).toBeDefined()
    expect(screen.getByRole('button', { name: /Grace Hopper/ })).toBeDefined()
    expect(onPatientChoice).toHaveBeenCalledWith({ kind: 'patient', patientId: 'p1' })
  })

  it('should offer every patient first, and hand back that choice', async () => {
    // Arrange
    const { onPatientChoice } = renderPicker({ 'Patient?': answer(bundleOf([adaWire])) })
    const [firstRow] = await screen.findAllByRole('button')

    // Act
    fireEvent.click(screen.getByRole('button', { name: /All patients/ }))

    // Assert
    expect(firstRow?.textContent).toMatch(/^All patients/)
    expect(onPatientChoice).toHaveBeenCalledWith({ kind: 'all-patients' })
  })

  it('should still offer every patient on a server with none, saying so', async () => {
    // Act
    renderPicker({ 'Patient?': answer(bundleOf([])) })

    // Assert
    expect(await screen.findByText('No patients on this server.')).toBeDefined()
    expect(screen.getByRole('button', { name: /All patients/ })).toBeDefined()
  })

  it('should give a patient without an id no row', async () => {
    // Act
    renderPicker({
      'Patient?': answer(bundleOf([{ ...graceWire, id: undefined }, adaWire])),
    })

    // Assert
    expect(await screen.findByRole('button', { name: /Ada Lovelace/ })).toBeDefined()
    expect(screen.queryByRole('button', { name: /Grace Hopper/ })).toBeNull()
  })

  it('should read the next page on More patients, and offer no more after the last', async () => {
    // Arrange
    renderPicker({
      'Patient?': answer(bundleOf([adaWire], NEXT_PATIENTS)),
      [NEXT_PATIENTS]: answer(bundleOf([graceWire])),
    })

    // Act
    fireEvent.click(await screen.findByRole('button', { name: 'More patients' }))

    // Assert
    expect(await screen.findByRole('button', { name: /Grace Hopper/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /Ada Lovelace/ })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'More patients' })).toBeNull()
  })

  it('should keep the rows and More patients as the retry when a later page fails', async () => {
    // Arrange
    renderPicker({
      'Patient?': answer(bundleOf([adaWire], NEXT_PATIENTS)),
      [NEXT_PATIENTS]: () => Promise.reject(new Error('page two failed')),
    })

    // Act
    fireEvent.click(await screen.findByRole('button', { name: 'More patients' }))

    // Assert
    expect(await screen.findByText(/^Could not load patients:/)).toBeDefined()
    expect(screen.getByRole('button', { name: /Ada Lovelace/ })).toBeDefined()
    expect(screen.getByRole('button', { name: 'More patients' })).toBeDefined()
  })

  it('should say the read failed when the first page does', async () => {
    // Act
    renderPicker({ 'Patient?': () => Promise.reject(new Error('search failed')) })

    // Assert
    expect(await screen.findByText(/^Could not load patients:/)).toBeDefined()
  })
})
