import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { JSX } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import type { OAuthConsentResource } from '../../queries/index.ts'
import { consentAsksForPatient } from './consent-asks-for-patient.ts'
import { OAuthConsentCard } from './oauth-consent-card.tsx'

/**
 * What the card adds over its use in `OAuthConsentForm` (whose tests cover the
 * editing and the decision): when its composer reads patients, and the name
 * search a composer can put above the picker.
 */

afterEach(() => {
  cleanup()
})

const consentFor = (scopes: readonly string[]): OAuthConsentResource => ({
  id: 'consent-1',
  clientId: 'fitbit-sync',
  clientName: 'Fitbit Sync',
  scopes,
  redirectUri: 'https://app.example/cb',
  preApprovedScopes: [],
  patient: null,
  registration: { status: 'registered' },
})

describe('consentAsksForPatient', () => {
  test.each([
    [['launch/patient', 'openid'], true],
    [['patient/Observation.rs'], true],
    [['user/Observation.rs', 'openid'], false],
    [['openid', 'fhirUser'], false],
  ])('%j → %s', (scopes, expected) => {
    expect(consentAsksForPatient(consentFor(scopes))).toBe(expected)
  })
})

describe('OAuthConsentCard — patient search', () => {
  const renderCard = (
    patientSearch?: Parameters<typeof OAuthConsentCard>[0]['patientSearch']
  ): void => {
    render(
      <OAuthConsentCard
        consent={consentFor(['launch/patient', 'openid'])}
        consentMutation={{ mutate: vi.fn(), isPending: false, error: null }}
        patients={{ options: [], loading: false, error: null }}
        patientSearch={patientSearch}
        onDone={vi.fn()}
      />
    )
  }

  test('without a search the patient bar has the picker alone', () => {
    renderCard()

    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByRole('button', { name: /No patient/ })).toBeDefined()
  })

  test('the search field shows the name and hands each edit to its composer', async () => {
    const onNameChange = vi.fn<(name: string) => void>()
    renderCard({ name: 'Le', onNameChange })

    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Find a patient' })
    expect(search.value).toBe('Le')
    await userEvent.setup({ delay: null }).type(search, 'e')

    expect(onNameChange).toHaveBeenLastCalledWith('Lee')
  })
})

describe('OAuthConsentCard — searching for a patient', () => {
  const jordan = { id: 'pat-1', displayName: 'Jordan Lee' }
  const sam = { id: 'pat-2', displayName: 'Sam Rivera' }

  const cardFor = (
    scopes: readonly string[],
    patients: readonly { readonly id: string; readonly displayName: string }[],
    name: string
  ): JSX.Element => (
    <OAuthConsentCard
      consent={consentFor(scopes)}
      consentMutation={{ mutate: vi.fn(), isPending: false, error: null }}
      patients={{ options: patients, loading: false, error: null }}
      patientSearch={{ name, onNameChange: vi.fn() }}
      onDone={vi.fn()}
    />
  )

  test('the picked patient stays named once a later search no longer lists them', async () => {
    const user = userEvent.setup({ delay: null })
    const { rerender } = render(cardFor(['launch/patient'], [jordan], 'Lee'))
    await user.click(screen.getByRole('button', { name: /No patient/ }))
    await user.click(screen.getByRole('option', { name: /Jordan Lee/ }))

    rerender(cardFor(['launch/patient'], [sam], 'Rivera'))

    expect(screen.getByRole('button', { name: /Jordan Lee/ })).toBeDefined()
  })

  test('a search nobody matches says so, rather than that the server has no patients', () => {
    render(cardFor(['patient/Observation.rs'], [], 'Nobody'))

    expect(screen.getByText('No patient matches “Nobody”.')).toBeDefined()
    expect(screen.queryByText(/no patients to choose from/)).toBeNull()
  })
})
