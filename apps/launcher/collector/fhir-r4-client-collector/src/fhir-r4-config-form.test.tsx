import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { defaultConfig } from './config.ts'
import { FhirR4ConfigForm } from './fhir-r4-config-form.tsx'

afterEach(() => {
  cleanup()
})

/** Render `FhirR4ConfigForm` standalone, with a `type="submit"` footer. */
const renderFhirForm = (
  overrides: {
    readonly initial?: typeof defaultConfig
    readonly prefill?: Record<string, string>
  } = {}
): { readonly onSubmit: ReturnType<typeof vi.fn> } => {
  const onSubmit = vi.fn()
  render(
    <FhirR4ConfigForm
      initial={overrides.initial}
      prefill={overrides.prefill}
      disabled={false}
      onSubmit={onSubmit}
      header={null}
      footer={<button type="submit">Save</button>}
    />
  )
  return { onSubmit }
}

describe('FhirR4ConfigForm', () => {
  test('seeds fields from defaultConfig and submits a decoded config', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderFhirForm()

    // The demo-server prefill flow: an unedited new form comes up populated.
    expect(screen.getByDisplayValue(defaultConfig.rootUrl)).toBeTruthy()
    expect(screen.getByDisplayValue(defaultConfig.patientId)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(defaultConfig)
  })

  test('seeds fields from an existing `initial` config on edit', () => {
    const initial = {
      _tag: 'fhir-r4',
      rootUrl: 'https://custom.example.test/fhir',
      patientId: 'custom-patient-1',
    } as const
    renderFhirForm({ initial })

    expect(screen.getByDisplayValue(initial.rootUrl)).toBeTruthy()
    expect(screen.getByDisplayValue(initial.patientId)).toBeTruthy()
  })

  test('a `prefill` key overrides the default while others fall back', () => {
    renderFhirForm({ prefill: { rootUrl: 'https://prefill.example.test/fhir' } })

    expect(screen.getByDisplayValue('https://prefill.example.test/fhir')).toBeTruthy()
    expect(screen.getByDisplayValue(defaultConfig.patientId)).toBeTruthy()
  })

  test('an invalid rootUrl blocks submit with an inline error, then submits once fixed', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderFhirForm()

    const rootUrl = screen.getByLabelText('Root URL')
    await user.clear(rootUrl)
    await user.type(rootUrl, 'not a url')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // Blocked at the client — no bad config round-trips to the server.
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/rootUrl/i)).toBeTruthy()

    // Fixing the field and resubmitting decodes and forwards the config.
    await user.clear(rootUrl)
    await user.type(rootUrl, 'https://fixed.example.test/fhir')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      _tag: 'fhir-r4',
      rootUrl: 'https://fixed.example.test/fhir',
      patientId: defaultConfig.patientId,
    })
  })
})
