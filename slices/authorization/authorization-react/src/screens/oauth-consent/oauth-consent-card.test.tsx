import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import {
  ErrorBodyRendererContext,
  type ErrorBodyRenderer,
} from '@wildflowerhealthio/react-tundraish'
import { Grant, GrantDraft, ScopeRequest } from '@wildflowerhealthio/scopes-core'
import type { PatientOption } from '@wildflowerhealthio/scopes-react'
import * as fc from 'fast-check'
import { type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import type { OAuthConsentResource, OAuthConsentResult } from '../../queries/index.ts'
import { consentAsksForPatient } from './consent-asks-for-patient.ts'
import { OAuthConsentCard, type OAuthConsentMutation } from './oauth-consent-card.tsx'

/**
 * `OAuthConsentCard` renders the scopes-react consent surface (plain-language
 * statements + the resource×interaction grid) over a `GrantDraft`, and submits
 * the *edited* grant. The tests drive the real card through the two seams its
 * composer fills:
 *
 *   - `consentMutation` — a spy `mutate` that records the approve/deny payload
 *     and drives `onSuccess` with a configurable result, so the tests can
 *     assert the exact `approvedScopes` the card emits.
 *   - `patients` — the launch-patient picker's options; empty by default, with
 *     per-test overrides via `patientOptions` / `patientsError`.
 *
 * A patient-context grant cannot be approved without a launch patient, so
 * {@link makeConsent} binds one by default (as an EHR launch does) and the tests
 * about scope editing stay about scopes; the launch-patient tests start from
 * `patient: null`.
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

/** The mutation's failure (what a rejected approve leaves on it), or `null`. */
let mutationError: Error | null = null

/**
 * The card's `consentMutation` over the {@link mutate} spy. The spy's
 * `onSuccess` takes the result alone, which is all the card reads; the rest of
 * TanStack's `onSuccess` arguments are filled in here.
 */
const stubConsentMutation = (error: Error | null): OAuthConsentMutation => ({
  mutate: (variables, options) => {
    mutate(variables, {
      onSuccess: (result) => {
        options?.onSuccess?.(result, variables, undefined, {
          client: new QueryClient(),
          meta: undefined,
        })
      },
    })
  },
  isPending: false,
  error,
})

/** The patients the composer lists. */
let patientOptions: readonly PatientOption[] = []
/** The patient list's read failure, or `null` when it reads. */
let patientsError: Error | null = null

beforeEach(() => {
  mutationError = null
  patientOptions = []
  patientsError = null
  // jsdom doesn't implement scrollIntoView; the card calls it to bring the error
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

const consentFor = (scopes: readonly string[]): OAuthConsentResource => ({
  id: 'consent-1',
  clientId: 'fitbit-sync',
  clientName: 'Fitbit Sync',
  scopes,
  redirectUri: 'https://app.example/cb',
  preApprovedScopes: [],
  patient: null,
  registration: { status: 'registered' },
  missingApprovalScopes: [],
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
        onAskOwner={vi.fn()}
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
      onAskOwner={vi.fn()}
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

describe('OAuthConsentCard — app identity', () => {
  test('the header names the app, demoting the client id to a mono line', () => {
    renderCard(makeConsent({ scopes: ['patient/Observation.r'], clientId: 'fitbit-sync' }), vi.fn())

    expect(screen.getByRole('heading', { name: 'Fitbit Sync' })).toBeDefined()
    expect(screen.getByText('fitbit-sync')).toBeDefined()
  })

  test('the header names the host the app sends the browser back to', () => {
    renderCard(
      makeConsent({
        scopes: ['patient/Observation.r'],
        redirectUri: 'https://sync.fitbit.example:8443/oauth/cb?x=1',
      }),
      vi.fn()
    )

    expect(screen.getByText('Returns you to', { exact: false }).textContent).toBe(
      'Returns you to sync.fitbit.example:8443'
    )
  })

  test('falls back to the client id as the subject when the name is empty', () => {
    renderCard(makeConsent({ scopes: ['patient/Observation.r'], clientName: '' }), vi.fn())

    expect(screen.getByRole('heading', { name: 'app.example' })).toBeDefined()
  })

  test('the app name subjects the statement lead-in (via ScopePicker)', () => {
    renderCard(makeConsent({ scopes: ['patient/Observation.r'] }), vi.fn())

    expect(screen.getByText('Fitbit Sync can')).toBeDefined()
  })
})

describe('OAuthConsentCard — seeding', () => {
  test('seeds every requested scope as granted, ignoring the pre-approved subset', async () => {
    // Arrange — pre-approval is a strict subset of the request; the form must ignore it.
    const scopes = ['patient/Observation.rs', 'patient/Condition.r', 'openid']
    const { user } = renderCard(
      makeConsent({ scopes, preApprovedScopes: ['patient/Condition.r'] }),
      vi.fn()
    )

    // Act — approve immediately, without touching anything.
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — the full requested set (canonicalized) is granted, not just the subset.
    expect(lastApprovedScopes()).toEqual(GrantDraft.serializeAll(GrantDraft.fromScopes(scopes)))
  })
})

describe('OAuthConsentCard — statement editing', () => {
  test('un-ticking one interaction drops it from the approved payload', async () => {
    // Arrange — a single Observation read/search statement.
    const { user } = renderCard(makeConsent({ scopes: ['patient/Observation.rs'] }), vi.fn())

    // Act — open the statement's picker and untick Read.
    await user.click(screen.getByRole('button', { name: /Read . Search/ }))
    await user.click(screen.getByRole('checkbox', { name: /Read/ }))
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — the grant is now search-only.
    expect(lastApprovedScopes()).toEqual(['patient/Observation.s'])
  })

  test('an out-of-envelope interaction renders disabled and cannot change the payload', async () => {
    // Arrange — only r/s were requested, so c/u/d are outside the envelope.
    const { user } = renderCard(makeConsent({ scopes: ['patient/Observation.rs'] }), vi.fn())
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

describe('OAuthConsentCard — flags', () => {
  test('a requested known flag toggles out of the payload', async () => {
    const { user } = renderCard(
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
    const { user } = renderCard(
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
      ;({ user } = renderCard(
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

describe('OAuthConsentCard — exclusions', () => {
  test('curated exclusion lines render without an action button', () => {
    renderCard(makeConsent({ scopes: ['patient/Observation.r'] }), vi.fn())

    // The informational line is present…
    expect(screen.getByText('Read or write other health record types')).toBeDefined()
    // …and carries no "+ Allow" / "Remove" affordance (`spec.md §8`).
    expect(screen.queryByRole('button', { name: '+ Allow' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })
})

describe('OAuthConsentCard — decision routing', () => {
  test('an approval passes the result through to onDone', async () => {
    const onDone = vi.fn()
    const { user } = renderCard(makeConsent({ scopes: ['patient/Observation.r'] }), onDone)

    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith({
      status: 'approved',
      redirect: 'https://app.example/cb?code=xyz',
    })
  })

  test('a decline passes the denied result through to onDone', async () => {
    const onDone = vi.fn()
    const { user } = renderCard(makeConsent({ scopes: ['patient/Observation.r'] }), onDone)

    await user.click(screen.getByRole('button', { name: 'Deny' }))

    expect(onDone).toHaveBeenCalledWith({ status: 'denied' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('an error result surfaces on the form and does not finish', async () => {
    mutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.({ status: 'error', message: 'Something went wrong' })
    })
    const onDone = vi.fn()
    const { user } = renderCard(makeConsent({ scopes: ['patient/Observation.r'] }), onDone)

    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // `ErrorBanner` prefixes an aria-hidden glyph + sr-only "Error:", so assert
    // the message is present rather than the exact textContent.
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong')
    // The error banner sits above the form, so it's scrolled into view.
    expect(scrollIntoView).toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  test('an approver-scope 403 renders through the app error surface, offering the step-up', () => {
    // Arrange — the approve failed: the approver's token lacks a ticked scope.
    mutationError = Object.assign(new Error('InsufficientScope'), {
      error: 'InsufficientScope',
      missingScopes: ['patient/Condition.rs'],
    })
    const renderer = vi.fn((error: unknown) =>
      typeof error === 'object' && error !== null && 'missingScopes' in error ? (
        <button type="button">Request access</button>
      ) : null
    )

    // Act
    renderCard(makeConsent({ scopes: ['patient/Observation.r'] }), vi.fn(), renderer)

    // Assert — the decoded body reaches the app's renderer, which owns the step-up.
    expect(renderer).toHaveBeenCalledWith(mutationError)
    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy()
  })

  test('an approval the server records as a denial passes the denied result to onDone', async () => {
    const denied = {
      status: 'denied' as const,
      redirect: 'https://app.example/cb?error=access_denied',
    }
    mutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.(denied)
    })
    const onDone = vi.fn()
    const { user } = renderCard(makeConsent({ scopes: ['patient/Observation.r'] }), onDone)

    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    expect(onDone).toHaveBeenCalledWith(denied)
  })
})

describe('OAuthConsentCard — empty grant', () => {
  test('Allow is disabled once every requested scope is pruned', async () => {
    const { user } = renderCard(makeConsent({ scopes: ['openid'] }), vi.fn())
    const allow = (): HTMLButtonElement =>
      screen.getByRole<HTMLButtonElement>('button', { name: 'Allow access' })
    expect(allow().disabled).toBe(false)

    // Toggle the only scope (the openid flag) off — the draft is now empty, which
    // the backend treats as a deny, so the approve action is blocked outright.
    await user.click(screen.getByRole('switch', { name: /Confirm who you are/ }))

    expect(allow().disabled).toBe(true)
  })
})

describe("OAuthConsentCard — asking the server's owner", () => {
  test('a reader lacking an approval scope asks the owner in place of Allow, saying why above the buttons', async () => {
    const onAskOwner = vi.fn()
    const { user } = renderCard(
      makeConsent({
        scopes: ['system/Observation.r'],
        registration: { status: 'new' },
        missingApprovalScopes: ['wildflower/Client.c'],
      }),
      vi.fn(),
      null,
      onAskOwner
    )

    expect(screen.queryByRole('button', { name: 'Allow access' })).toBeNull()
    const reason = screen.getByText("This browser can't allow this app.")
    const askOwner = screen.getByRole('button', { name: "Ask the server's owner" })
    expect(reason.compareDocumentPosition(askOwner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await user.click(askOwner)
    expect(onAskOwner).toHaveBeenCalledOnce()
    expect(mutate).not.toHaveBeenCalled()
  })

  test('a reader lacking an approval scope gets none of the decision controls', () => {
    renderCard(
      makeConsent({
        scopes: ['patient/Observation.r'],
        registration: { status: 'new' },
        missingApprovalScopes: ['wildflower/Client.c'],
      }),
      vi.fn()
    )

    expect(screen.queryByText('This app has never been seen before')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByText('Patient')).toBeNull()
    expect(screen.queryByText(/can't yet limit an app to one patient/)).toBeNull()
  })

  test('a reader lacking nothing gets Allow and no reason', () => {
    renderCard(makeConsent({ scopes: ['system/Observation.r'] }), vi.fn())

    expect(screen.getByRole('button', { name: 'Allow access' })).toBeDefined()
    expect(screen.queryByRole('button', { name: "Ask the server's owner" })).toBeNull()
    expect(screen.queryByText("This browser can't allow this app.")).toBeNull()
  })

  test('a reader asking the owner can still deny', async () => {
    const onDone = vi.fn()
    const { user } = renderCard(
      makeConsent({
        scopes: ['system/Observation.r'],
        missingApprovalScopes: ['wildflower/Grant.c'],
      }),
      onDone
    )

    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(mutate.mock.calls.at(-1)?.[0]).toEqual({ kind: 'deny', id: 'consent-1' })
    expect(onDone).toHaveBeenCalledWith({ status: 'denied' })
  })

  test("a reader that can't decide the request at all gets no Deny, only Ask the server's owner", () => {
    renderCard(
      makeConsent({
        scopes: ['system/Observation.r'],
        missingApprovalScopes: ['wildflower/AuthorizationRequest.u', 'wildflower/Grant.c'],
      }),
      vi.fn()
    )

    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    expect(screen.getByRole('button', { name: "Ask the server's owner" })).toBeDefined()
  })
})

describe('OAuthConsentCard — registration warning', () => {
  test('a registered app shows no callout and no checkbox, and Approve works as before', async () => {
    const { user } = renderCard(
      makeConsent({ scopes: ['system/Observation.r'], registration: { status: 'registered' } }),
      vi.fn()
    )

    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /recognise/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Allow access' }))
    expect(lastApprovedScopes()).toEqual(['system/Observation.r'])
    const lastCall = mutate.mock.calls.at(-1)?.[0]
    expect(lastCall).toMatchObject({
      kind: 'approve',
      payload: { acknowledgedRegistration: false },
    })
  })

  test('a new app names the client id and redirect origin, and blocks Approve until acknowledged', async () => {
    const { user } = renderCard(
      makeConsent({
        scopes: ['system/Observation.r'],
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
    renderCard(
      makeConsent({
        scopes: ['system/Observation.r'],
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
    renderCard(
      makeConsent({
        scopes: ['system/Observation.r', 'openid'],
        registration: {
          status: 'changed',
          redirectUriIsNew: false,
          newScopes: ['system/Observation.r', 'openid'],
        },
      }),
      vi.fn()
    )

    // `openid` is a known flag with a plain-language label; the resource scope
    // has no single-line label outside the picker grid, so it falls back to raw.
    const callout = within(screen.getByRole('note'))
    expect(callout.getByText('Confirm who you are')).toBeDefined()
    expect(callout.getByText('system/Observation.r')).toBeDefined()
  })

  test('unticking the checkbox after approving re-disables Approve', async () => {
    const { user } = renderCard(
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
          <OAuthConsentCard
            consent={makeConsent({
              scopes: newScopes,
              registration: { status: 'changed', redirectUriIsNew: false, newScopes },
            })}
            consentMutation={stubConsentMutation(null)}
            patients={{ options: [], loading: false, error: null }}
            onDone={vi.fn()}
            onAskOwner={vi.fn()}
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

describe('OAuthConsentCard — launch patient', () => {
  test('approving with no patient selected shows a validation error and does not submit', async () => {
    // Arrange — a patient-context request with a pickable patient, none selected.
    patientOptions = [{ id: 'pat-1', displayName: 'Jordan Lee' }]
    const { user } = renderCard(unboundConsent(['patient/Observation.r']), vi.fn())

    // Act
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — the miss is surfaced, scrolled into view, and nothing was sent.
    expect((await screen.findByRole('alert')).textContent).toBe('Select a patient to continue.')
    expect(scrollIntoView).toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  test('selecting a patient clears the error and submits that patient id', async () => {
    // Arrange — trip the validation error first.
    patientOptions = [{ id: 'pat-1', displayName: 'Jordan Lee' }]
    const { user } = renderCard(unboundConsent(['patient/Observation.r']), vi.fn())
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

  test('pruning every patient scope hides the picker and drops the patient', async () => {
    // `launch/patient` plus a non-patient flag, with a patient picked.
    patientOptions = [{ id: 'pat-1', displayName: 'Jordan Lee' }]
    const { user } = renderCard(unboundConsent(['launch/patient', 'openid']), vi.fn())
    await user.click(screen.getByRole('button', { name: /No patient/ }))
    await user.click(screen.getByRole('option', { name: /Jordan Lee/ }))

    // Prune `launch/patient`; `openid` remains.
    await user.click(screen.getByRole('switch', { name: /Open a specific patient/ }))

    // The picker is gone and approving sends no patient.
    expect(screen.queryByRole('button', { name: /Jordan Lee/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    const lastCall = mutate.mock.calls.at(-1)?.[0]
    expect(lastCall).toMatchObject({ kind: 'approve', payload: { patient: null } })
    expect(lastApprovedScopes()).toEqual(['openid'])
  })

  test('a server with no patients says so, and a patient-context grant cannot be approved', async () => {
    // Arrange — a patient-context request against an empty patient list.
    const { user } = renderCard(unboundConsent(['patient/Observation.r']), vi.fn())

    // Act
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — the empty list is explained rather than the bar vanishing, and no
    // patientless approval went out.
    expect(screen.getByText(/no patients to choose from/)).toBeDefined()
    expect((await screen.findByRole('alert')).textContent).toBe('Select a patient to continue.')
    expect(mutate).not.toHaveBeenCalled()
  })

  test('a patient list that could not be read shows why, and blocks a patient-context grant', async () => {
    // Arrange — the Patient search failed (a mis-addressed request, a 403, …).
    patientsError = new Error('Patient search returned 404')
    const { user } = renderCard(unboundConsent(['patient/Observation.r']), vi.fn())

    // Act
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert
    expect(screen.getAllByText(/Patient search returned 404/)).not.toHaveLength(0)
    expect(mutate).not.toHaveBeenCalled()
  })

  test('a patient-context scope alongside launch/patient still requires a patient', async () => {
    // Arrange
    patientOptions = [{ id: 'pat-1', displayName: 'Jordan Lee' }]
    const { user } = renderCard(
      unboundConsent(['patient/Observation.r', 'launch/patient']),
      vi.fn()
    )

    // Act
    await user.click(screen.getByRole('button', { name: /Select a Patient/ }))

    // Assert — only the real patients are offered, and approving without one is blocked.
    expect(screen.queryByRole('option', { name: /No patient/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Allow access' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Select a patient to continue.')
    expect(mutate).not.toHaveBeenCalled()
  })

  test('pruning the patient-context scope leaves launch/patient with an optional patient', async () => {
    // Arrange — trip the validation error while the patient-context scope is granted.
    patientOptions = [{ id: 'pat-1', displayName: 'Jordan Lee' }]
    const { user } = renderCard(
      unboundConsent(['patient/Observation.r', 'launch/patient']),
      vi.fn()
    )
    await user.click(screen.getByRole('button', { name: 'Allow access' }))
    expect(screen.getByRole('alert').textContent).toBe('Select a patient to continue.')

    // Act — untick the only interaction of the patient-context statement, then approve.
    await user.click(screen.getByRole('button', { name: /^Read$/ }))
    await user.click(screen.getByRole('checkbox', { name: /Read/ }))

    // Assert — the stale error is gone, the picker offers "No patient", and the
    // approval goes out without one.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: /No patient/ })).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Allow access' }))
    expect(mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'approve',
      payload: { patient: null },
    })
    expect(lastApprovedScopes()).toEqual(['launch/patient'])
  })
})

describe('OAuthConsentCard — patient-scope warning', () => {
  const warning = /can't yet limit an app to one patient/

  test('a patient-context scope shows the warning above the buttons', () => {
    renderCard(makeConsent({ scopes: ['patient/Observation.rs'] }), vi.fn())

    const note = screen.getByText(warning)
    expect(note.getAttribute('role')).toBe('note')
    // Messages sit above the actions: the warning precedes the Allow button.
    const allow = screen.getByRole('button', { name: 'Allow access' })
    expect(note.compareDocumentPosition(allow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('a system-only request shows no warning', () => {
    renderCard(makeConsent({ scopes: ['system/Observation.rs'] }), vi.fn())

    expect(screen.queryByText(warning)).toBeNull()
  })

  test('unticking every patient-context interaction removes the warning', async () => {
    // Arrange — a patient-context read alongside a system-context search.
    const { user } = renderCard(
      makeConsent({ scopes: ['patient/Observation.r', 'system/Condition.s'] }),
      vi.fn()
    )
    expect(screen.getByText(warning)).toBeDefined()

    // Act — untick the patient-context statement's only interaction.
    await user.click(screen.getByRole('button', { name: /^Read$/ }))
    await user.click(screen.getByRole('checkbox', { name: /Read/ }))

    // Assert — the draft grants no patient-context scope, so the warning is gone.
    expect(screen.queryByText(warning)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Allow access' }))
    expect(lastApprovedScopes()).toEqual(['system/Condition.s'])
  })
})

describe('OAuthConsentCard — optional launch patient', () => {
  test('launch/patient alone defaults to "No patient" and approves without one', async () => {
    // Arrange — `launch/patient` with no patient-context scope, a patient available.
    patientOptions = [{ id: 'pat-1', displayName: 'Jordan Lee' }]
    const { user } = renderCard(unboundConsent(['launch/patient', 'openid']), vi.fn())

    // Act
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — no validation error, and the approval carries no patient.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'approve',
      payload: { patient: null },
    })
    expect(lastApprovedScopes()).toEqual(['launch/patient', 'openid'])
  })

  test('launch/patient alone sends the patient the owner picks', async () => {
    // Arrange
    patientOptions = [{ id: 'pat-1', displayName: 'Jordan Lee' }]
    const { user } = renderCard(unboundConsent(['launch/patient', 'openid']), vi.fn())

    // Act
    await user.click(screen.getByRole('button', { name: /No patient/ }))
    await user.click(screen.getByRole('option', { name: /Jordan Lee/ }))
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert
    expect(mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'approve',
      payload: { patient: 'pat-1' },
    })
  })

  test('choosing "No patient" after a patient drops it from the approval', async () => {
    // Arrange — the launch already carries a patient.
    patientOptions = [{ id: 'pat-launch', displayName: 'Jordan Lee' }]
    const { user } = renderCard(makeConsent({ scopes: ['launch/patient'] }), vi.fn())

    // Act — the bound patient is preselected; switch to "No patient".
    await user.click(screen.getByRole('button', { name: /Jordan Lee/ }))
    await user.click(screen.getByRole('option', { name: /No patient/ }))
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert
    expect(mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'approve',
      payload: { patient: null },
    })
  })

  test('a consent that carries a patient preselects and sends it', async () => {
    // Arrange
    patientOptions = [{ id: 'pat-launch', displayName: 'Jordan Lee' }]
    const { user } = renderCard(makeConsent({ scopes: ['launch/patient'] }), vi.fn())

    // Act
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert
    expect(screen.getByRole('button', { name: /Jordan Lee/ })).toBeDefined()
    expect(mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'approve',
      payload: { patient: 'pat-launch' },
    })
  })

  test('with no patients to pick, launch/patient alone still approves', async () => {
    // Arrange — nothing to pick from.
    const { user } = renderCard(unboundConsent(['launch/patient', 'openid']), vi.fn())

    // Act
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert — no "turn off patient access" note, and the approval goes out.
    expect(screen.queryByText(/no patients to choose from/)).toBeNull()
    expect(mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'approve',
      payload: { patient: null },
    })
  })

  test('with an unreadable patient list, launch/patient alone still approves', async () => {
    // Arrange
    patientsError = new Error('Patient search returned 404')
    const { user } = renderCard(unboundConsent(['launch/patient', 'openid']), vi.fn())

    // Act
    await user.click(screen.getByRole('button', { name: 'Allow access' }))

    // Assert
    expect(screen.getAllByText(/Patient search returned 404/)).not.toHaveLength(0)
    expect(mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'approve',
      payload: { patient: null },
    })
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

describe('OAuthConsentCard — property (end-to-end seeding)', () => {
  test('the seeded approve payload always stays within the requested envelope', async () => {
    await fc.assert(
      fc.asyncProperty(requestedArb, async (scopes) => {
        const { user } = renderCard(makeConsent({ scopes }), vi.fn())
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
  patient: 'pat-launch',
  registration: { status: 'registered' },
  missingApprovalScopes: [],
  ...overrides,
})

/** A consent for `scopes` with no launch patient bound yet — a standalone launch. */
const unboundConsent = (scopes: readonly string[]): OAuthConsentResource =>
  makeConsent({ scopes, patient: null })

const renderCard = (
  consent: OAuthConsentResource,
  onDone: (result: OAuthConsentResult) => void,
  errorBodyRenderer: ErrorBodyRenderer | null = null,
  onAskOwner: () => void = vi.fn()
): { readonly user: ReturnType<typeof userEvent.setup> } => {
  // No timer between pointer actions: the property renders and clicks once per run.
  const user = userEvent.setup({ delay: null })
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <ErrorBodyRendererContext.Provider value={errorBodyRenderer}>
      {children}
    </ErrorBodyRendererContext.Provider>
  )
  render(
    <OAuthConsentCard
      consent={consent}
      consentMutation={stubConsentMutation(mutationError)}
      patients={{ options: patientOptions, loading: false, error: patientsError }}
      onDone={onDone}
      onAskOwner={onAskOwner}
    />,
    { wrapper }
  )
  return { user }
}
