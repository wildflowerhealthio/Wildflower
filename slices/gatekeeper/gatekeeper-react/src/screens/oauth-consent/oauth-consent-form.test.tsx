import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { type JSX, type ReactNode } from 'react'
import { Grant, GrantDraft, ScopeRequest } from 'scopes-core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import type { OAuthConsentResource, OAuthConsentResult } from '../../queries/index.ts'
import { OAuthConsentForm } from './oauth-consent-form.tsx'

/**
 * `OAuthConsentForm` renders the scopes-react consent surface (plain-language statements +
 * the resource×interaction grid) over a `GrantDraft`, and submits the *edited* grant. The
 * unit worth testing is the draft-editing + submission wiring, so we drive the real form and
 * stub only its two data seams:
 *
 *   - `useOAuthConsentMutation` — replaced by a spy `mutate` that records the approve/deny
 *     payload and drives `onSuccess` with a configurable result. This is the only way to
 *     assert the exact `approvedScopes` the form emits (the real mutation buries the payload
 *     inside an Effect handed to `runAuthed`).
 *   - `usePatientsQuery` — the launch-patient picker's data source; defaults to empty so
 *     the picker stays hidden, with per-test overrides via `patientResources` for the
 *     launch-patient selection tests.
 */

type ApproveVars = {
  readonly kind: 'approve'
  readonly id: string
  readonly payload: { readonly approvedScopes: readonly string[]; readonly patient: string | null }
}
type DenyVars = { readonly kind: 'deny'; readonly id: string }
type MutateVars = ApproveVars | DenyVars
type MutateOptions = { readonly onSuccess?: (result: OAuthConsentResult) => void }

const mutate = vi.fn<(variables: MutateVars, options?: MutateOptions) => void>()

vi.mock('../../queries/index.ts', () => ({
  useOAuthConsentMutation: (): {
    mutate: typeof mutate
    isPending: boolean
    error: null
  } => ({ mutate, isPending: false, error: null }),
}))

/** The minimal FHIR Patient shape `usePatientOptions` reads. */
type StubPatient = {
  readonly id: string
  readonly name?: readonly { readonly given?: readonly string[]; readonly family?: string }[]
}
let patientResources: readonly StubPatient[] = []

vi.mock('fhir-r4-react', () => ({
  usePatientsQuery: (): { data: readonly StubPatient[]; isLoading: boolean } => ({
    data: patientResources,
    isLoading: false,
  }),
}))

beforeEach(() => {
  patientResources = []
  mutate.mockReset()
  // Default: the server records the decision the user asked for.
  mutate.mockImplementation((variables, options) => {
    options?.onSuccess?.(
      variables.kind === 'approve'
        ? { status: 'approved', redirect: 'https://app.example/cb?code=xyz' }
        : { status: 'denied' }
    )
  })
})

afterEach(() => {
  cleanup()
})

/** The `approvedScopes` recorded by the last approve call, or `undefined` if none. */
const lastApprovedScopes = (): readonly string[] | undefined => {
  for (let i = mutate.mock.calls.length - 1; i >= 0; i -= 1) {
    const variables = mutate.mock.calls[i]?.[0]
    if (variables?.kind === 'approve') return variables.payload.approvedScopes
  }
  return undefined
}

describe('OAuthConsentForm — app identity', () => {
  test('the header names the app, demoting the client id to a mono line', () => {
    renderForm(makeConsent({ scopes: ['patient/Observation.r'] }), vi.fn())

    expect(screen.getByRole('heading', { name: 'Fitbit Sync' })).toBeDefined()
    expect(screen.getByText('app.example')).toBeDefined()
  })

  test('falls back to the client id as the subject when the name is empty', () => {
    renderForm(makeConsent({ scopes: ['patient/Observation.r'], clientName: '' }), vi.fn())

    expect(screen.getByRole('heading', { name: 'app.example' })).toBeDefined()
  })

  test('the app name subjects the statement lead-in (via ScopePicker)', () => {
    renderForm(makeConsent({ scopes: ['patient/Observation.r'] }), vi.fn())

    expect(screen.getByText('Fitbit Sync can')).toBeDefined()
  })
})

describe('OAuthConsentForm — seeding', () => {
  test('seeds every requested scope as granted, ignoring the pre-approved subset', async () => {
    // Arrange — pre-approval is a strict subset of the request; the form must ignore it.
    const scopes = ['patient/Observation.rs', 'patient/Condition.r', 'openid']
    const { user } = renderForm(
      makeConsent({ scopes, preApprovedScopes: ['patient/Condition.r'] }),
      vi.fn()
    )

    // Act — approve immediately, without touching anything.
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — the full requested set (canonicalized) is granted, not just the subset.
    expect(lastApprovedScopes()).toEqual(GrantDraft.serializeAll(GrantDraft.fromScopes(scopes)))
  })
})

describe('OAuthConsentForm — statement editing', () => {
  test('un-ticking one interaction drops it from the approved payload', async () => {
    // Arrange — a single Observation read/search statement.
    const { user } = renderForm(makeConsent({ scopes: ['patient/Observation.rs'] }), vi.fn())

    // Act — open the statement's picker and untick Read.
    await user.click(screen.getByRole('button', { name: /Read . Search/ }))
    await user.click(screen.getByRole('checkbox', { name: /Read/ }))
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — the grant is now search-only.
    expect(lastApprovedScopes()).toEqual(['patient/Observation.s'])
  })

  test('an out-of-envelope interaction renders disabled and cannot change the payload', async () => {
    // Arrange — only r/s were requested, so c/u/d are outside the envelope.
    const { user } = renderForm(makeConsent({ scopes: ['patient/Observation.rs'] }), vi.fn())
    await user.click(screen.getByRole('button', { name: /Read . Search/ }))

    // Assert — Create is disabled…
    const create = screen.getByRole<HTMLInputElement>('checkbox', { name: /Create/ })
    expect(create.disabled).toBe(true)

    // Act — clicking it does nothing…
    await user.click(create)
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — the payload is unchanged.
    expect(lastApprovedScopes()).toEqual(['patient/Observation.rs'])
  })
})

describe('OAuthConsentForm — flags', () => {
  test('a requested known flag toggles out of the payload', async () => {
    const { user } = renderForm(
      makeConsent({ scopes: ['patient/Observation.r', 'openid'] }),
      vi.fn()
    )

    // Sanity — openid is seeded in.
    await user.click(screen.getByRole('button', { name: 'Allow access' }))
    expect(lastApprovedScopes()).toContain('openid')

    // Act — toggle openid off (its plain-language row), then approve again.
    await user.click(screen.getByRole('switch', { name: /Confirm who you are/ }))
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — openid is gone, the resource scope remains.
    expect(lastApprovedScopes()).toEqual(['patient/Observation.r'])
  })

  test('a requested unknown scope round-trips through its own toggle', async () => {
    const { user } = renderForm(
      makeConsent({ scopes: ['patient/Observation.r', 'x-custom-scope'] }),
      vi.fn()
    )

    await user.click(screen.getByRole('switch', { name: /x-custom-scope/ }))
    await user.click(screen.getByRole('button', { name: 'Allow access' }))
    expect(lastApprovedScopes()).toEqual(['patient/Observation.r'])
  })
})

describe('OAuthConsentForm — exclusions', () => {
  test('curated exclusion lines render without an action button', () => {
    renderForm(makeConsent({ scopes: ['patient/Observation.r'] }), vi.fn())

    // The informational line is present…
    expect(screen.getByText('Read or write other health record types')).toBeDefined()
    // …and carries no "+ Allow" / "Remove" affordance (`spec.md §8`).
    expect(screen.queryByRole('button', { name: '+ Allow' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })
})

describe('OAuthConsentForm — decision routing', () => {
  test('an approval passes the result through to onDone', async () => {
    const onDone = vi.fn()
    const { user } = renderForm(makeConsent({ scopes: ['patient/Observation.r'] }), onDone)

    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith({
      status: 'approved',
      redirect: 'https://app.example/cb?code=xyz',
    })
  })

  test('a decline passes the denied result through to onDone', async () => {
    const onDone = vi.fn()
    const { user } = renderForm(makeConsent({ scopes: ['patient/Observation.r'] }), onDone)

    await user.click(screen.getByRole('button', { name: 'Deny' }))

    expect(onDone).toHaveBeenCalledWith({ status: 'denied' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('an error result surfaces on the form and does not finish', async () => {
    mutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.({ status: 'error', message: 'Something went wrong' })
    })
    const onDone = vi.fn()
    const { user } = renderForm(makeConsent({ scopes: ['patient/Observation.r'] }), onDone)

    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong')
    expect(onDone).not.toHaveBeenCalled()
  })

  test('a denied approval shows the denial notice and stays on the form', async () => {
    mutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.({ status: 'denied' })
    })
    const onDone = vi.fn()
    const { user } = renderForm(makeConsent({ scopes: ['patient/Observation.r'] }), onDone)

    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Authorization request was denied.')
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('OAuthConsentForm — launch patient', () => {
  test('approving with no patient selected shows a validation error and does not submit', async () => {
    // Arrange — a patient-context request with a pickable patient, none selected.
    patientResources = [{ id: 'pat-1', name: [{ given: ['Jordan'], family: 'Lee' }] }]
    const { user } = renderForm(makeConsent({ scopes: ['patient/Observation.r'] }), vi.fn())

    // Act
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — the miss is surfaced and nothing was sent.
    expect((await screen.findByRole('alert')).textContent).toBe('Select a patient to continue.')
    expect(mutate).not.toHaveBeenCalled()
  })

  test('selecting a patient clears the error and submits that patient id', async () => {
    // Arrange — trip the validation error first.
    patientResources = [{ id: 'pat-1', name: [{ given: ['Jordan'], family: 'Lee' }] }]
    const { user } = renderForm(makeConsent({ scopes: ['patient/Observation.r'] }), vi.fn())
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Act — pick the patient, then approve.
    await user.click(screen.getByRole('button', { name: /Select a Patient/ }))
    await user.click(screen.getByRole('option', { name: /Jordan Lee/ }))
    expect(screen.queryByRole('alert')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — the approval carries the selected patient.
    const lastCall = mutate.mock.calls.at(-1)?.[0]
    expect(lastCall).toMatchObject({ kind: 'approve', payload: { patient: 'pat-1' } })
  })
})

// A requested v2 scope set over the real catalog × contexts × cruds letters.
const contextArb = fc.constantFrom('patient', 'user', 'system')
const resourceNameArb = fc.constantFrom('Observation', 'Condition', 'Encounter', 'Patient')
const lettersArb = fc.uniqueArray(fc.constantFrom('c', 'r', 'u', 'd', 's'), { minLength: 1 })
const scopeStringArb = fc
  .record({ context: contextArb, name: resourceNameArb, letters: lettersArb })
  .map(({ context, name, letters }) => `${context}/${name}.${letters.join('')}`)
const requestedArb = fc.uniqueArray(scopeStringArb, { minLength: 1, maxLength: 5 })

describe('OAuthConsentForm — property (end-to-end seeding)', () => {
  test('the seeded approve payload always stays within the requested envelope', async () => {
    await fc.assert(
      fc.asyncProperty(requestedArb, async (scopes) => {
        const { user } = renderForm(makeConsent({ scopes }), vi.fn())
        await user.click(screen.getByRole('button', { name: 'Allow access' }))

        const approved = lastApprovedScopes() ?? []
        const request = ScopeRequest.fromRequestedScopes({ optional: scopes })
        expect(ScopeRequest.isWithin({ patient: null, ...Grant.parse(approved) }, request)).toBe(
          true
        )

        cleanup()
        mutate.mockClear()
      }),
      { numRuns: numRunsFor({ base: 8 }) }
    )
  })
})

// Helpers

const makeConsent = (
  overrides: Partial<OAuthConsentResource> & Pick<OAuthConsentResource, 'scopes'>
): OAuthConsentResource => ({
  id: 'consent-1',
  clientId: 'app.example',
  clientName: 'Fitbit Sync',
  redirectUri: 'https://app.example/cb',
  preApprovedScopes: [],
  patient: null,
  ...overrides,
})

const renderForm = (
  consent: OAuthConsentResource,
  onDone: (result: OAuthConsentResult) => void
): { readonly user: ReturnType<typeof userEvent.setup> } => {
  const queryClient = new QueryClient()
  const user = userEvent.setup()
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  render(<OAuthConsentForm consent={consent} onDone={onDone} />, { wrapper })
  return { user }
}
