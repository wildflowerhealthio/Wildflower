import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
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

/** The stubbed `scrollIntoView` (jsdom has none); re-armed each test. */
let scrollIntoView = vi.fn()

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
  // jsdom doesn't implement scrollIntoView; the form calls it to bring the error
  // banner / patient bar into view. Stub it so those code paths don't throw (and
  // so tests can assert the scroll-into-view happened).
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView
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

  // The server no longer filters scopes against a grammar, so `scopes` can carry
  // arbitrary strings with no established shape — neither the FHIR/Wildflower
  // resource grammar nor a known flag. `Grant.parse`'s total-parse fallback
  // (`UnknownScope`) and the picker's opaque-toggle row must handle these without
  // throwing or silently dropping them.
  test('unparseable scope strings render as opaque named toggles without throwing', async () => {
    let user!: ReturnType<typeof userEvent.setup>
    expect(() => {
      ;({ user } = renderForm(
        makeConsent({ scopes: ['patient/Observation.r', 'totally/unknown.thing', 'weird'] }),
        vi.fn()
      ))
    }).not.toThrow()

    expect(screen.getByRole('switch', { name: /totally\/unknown\.thing/ })).toBeDefined()
    expect(screen.getByRole('switch', { name: /weird/ })).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Allow access' }))
    expect(lastApprovedScopes()).toEqual(
      expect.arrayContaining(['patient/Observation.r', 'totally/unknown.thing', 'weird'])
    )
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

    // `ErrorBanner` prefixes an aria-hidden glyph + sr-only "Error:", so assert
    // the message is present rather than the exact textContent.
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong')
    // The error banner sits above the form, so it's scrolled into view.
    expect(scrollIntoView).toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  test('a denied approval shows the denial notice and stays on the form', async () => {
    mutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.({ status: 'denied' })
    })
    const onDone = vi.fn()
    const { user } = renderForm(makeConsent({ scopes: ['patient/Observation.r'] }), onDone)

    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Authorization request was denied.'
    )
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('OAuthConsentForm — empty grant', () => {
  test('Allow is disabled once every requested scope is pruned', async () => {
    const { user } = renderForm(makeConsent({ scopes: ['openid'] }), vi.fn())
    const allow = (): HTMLButtonElement =>
      screen.getByRole<HTMLButtonElement>('button', { name: 'Allow access' })
    expect(allow().disabled).toBe(false)

    // Toggle the only scope (the openid flag) off — the draft is now empty, which
    // the backend treats as a deny, so the approve action is blocked outright.
    await user.click(screen.getByRole('switch', { name: /Confirm who you are/ }))

    expect(allow().disabled).toBe(true)
  })
})

describe('OAuthConsentForm — registration warning', () => {
  test('a registered app shows no callout and no checkbox, and Approve works as before', async () => {
    const { user } = renderForm(
      makeConsent({ scopes: ['patient/Observation.r'], registration: { status: 'registered' } }),
      vi.fn()
    )

    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /recognise/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Allow access' }))
    expect(lastApprovedScopes()).toEqual(['patient/Observation.r'])
    const lastCall = mutate.mock.calls.at(-1)?.[0]
    expect(lastCall).toMatchObject({
      kind: 'approve',
      payload: { acknowledgedRegistration: false },
    })
  })

  test('a new app names the client id and redirect origin, and blocks Approve until acknowledged', async () => {
    const { user } = renderForm(
      makeConsent({
        scopes: ['patient/Observation.r'],
        clientId: 'unknown-app.example',
        redirectUri: 'https://unknown-app.example/callback',
        registration: { status: 'new' },
      }),
      vi.fn()
    )

    const callout = within(screen.getByRole('note'))
    expect(callout.getByText('This app has never been seen before')).toBeDefined()
    expect(callout.getByText('unknown-app.example')).toBeDefined()
    expect(callout.getByText('https://unknown-app.example')).toBeDefined()
    expect(callout.getByText('https://unknown-app.example/callback')).toBeDefined()

    const allow = screen.getByRole<HTMLButtonElement>('button', { name: 'Allow access' })
    expect(allow.disabled).toBe(true)

    await user.click(screen.getByRole('checkbox', { name: /recognise this app/ }))
    expect(allow.disabled).toBe(false)

    await user.click(allow)
    const lastCall = mutate.mock.calls.at(-1)?.[0]
    expect(lastCall).toMatchObject({
      kind: 'approve',
      payload: { acknowledgedRegistration: true },
    })
  })

  test('a changed redirect shows the new origin and full uri', () => {
    renderForm(
      makeConsent({
        scopes: ['patient/Observation.r'],
        redirectUri: 'https://app.example/new-callback',
        registration: {
          status: 'changed',
          redirectUriIsNew: true,
          newScopes: [],
        },
      }),
      vi.fn()
    )

    const callout = within(screen.getByRole('note'))
    expect(callout.getByText("This app's request differs from its registration")).toBeDefined()
    expect(callout.getByText('https://app.example')).toBeDefined()
    expect(callout.getByText('https://app.example/new-callback')).toBeDefined()
  })

  test('changed scopes render as a list, falling back to the raw string for a resource scope', () => {
    renderForm(
      makeConsent({
        scopes: ['patient/Observation.r', 'openid'],
        registration: {
          status: 'changed',
          redirectUriIsNew: false,
          newScopes: ['patient/Observation.r', 'openid'],
        },
      }),
      vi.fn()
    )

    // `openid` is a known flag with a plain-language label; the resource scope
    // has no single-line label outside the picker grid, so it falls back to raw.
    const callout = within(screen.getByRole('note'))
    expect(callout.getByText('Confirm who you are')).toBeDefined()
    expect(callout.getByText('patient/Observation.r')).toBeDefined()
  })

  test('unticking the checkbox after approving re-disables Approve', async () => {
    const { user } = renderForm(
      makeConsent({ scopes: ['patient/Observation.r'], registration: { status: 'new' } }),
      vi.fn()
    )
    const checkbox = screen.getByRole('checkbox', { name: /recognise this app/ })
    const allow = screen.getByRole<HTMLButtonElement>('button', { name: 'Allow access' })

    await user.click(checkbox)
    expect(allow.disabled).toBe(false)

    await user.click(checkbox)
    expect(allow.disabled).toBe(true)
  })

  const newScopesArb = fc.uniqueArray(scopeStringArb, { minLength: 1, maxLength: 5 })

  test('every changed newScope appears in the callout', () => {
    fc.assert(
      fc.property(newScopesArb, (newScopes) => {
        const { unmount } = render(
          <OAuthConsentForm
            consent={makeConsent({
              scopes: newScopes,
              registration: { status: 'changed', redirectUriIsNew: false, newScopes },
            })}
            onDone={vi.fn()}
          />
        )

        for (const scope of newScopes) {
          expect(screen.getAllByText(scope).length).toBeGreaterThan(0)
        }

        unmount()
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })
})

describe('OAuthConsentForm — launch patient', () => {
  test('approving with no patient selected shows a validation error and does not submit', async () => {
    // Arrange — a patient-context request with a pickable patient, none selected.
    patientResources = [{ id: 'pat-1', name: [{ given: ['Jordan'], family: 'Lee' }] }]
    const { user } = renderForm(makeConsent({ scopes: ['patient/Observation.r'] }), vi.fn())

    // Act
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — the miss is surfaced, scrolled into view, and nothing was sent.
    expect((await screen.findByRole('alert')).textContent).toBe('Select a patient to continue.')
    expect(scrollIntoView).toHaveBeenCalled()
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

  test('pruning every patient scope hides the picker and drops the patient requirement', async () => {
    // A patient-context flag plus a non-patient flag, with a pickable patient.
    patientResources = [{ id: 'pat-1', name: [{ given: ['Jordan'], family: 'Lee' }] }]
    const { user } = renderForm(makeConsent({ scopes: ['launch/patient', 'openid'] }), vi.fn())

    // While a patient-context scope is granted, the picker is shown.
    expect(screen.getByRole('button', { name: /Select a Patient/ })).toBeDefined()

    // Prune the patient-context scope (`launch/patient`); `openid` remains.
    await user.click(screen.getByRole('switch', { name: /Open a specific patient/ }))

    // The picker is gone and approving no longer requires (or sends) a patient.
    expect(screen.queryByRole('button', { name: /Select a Patient/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    const lastCall = mutate.mock.calls.at(-1)?.[0]
    expect(lastCall).toMatchObject({ kind: 'approve', payload: { patient: null } })
    expect(lastApprovedScopes()).toEqual(['openid'])
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
  registration: { status: 'registered' },
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
