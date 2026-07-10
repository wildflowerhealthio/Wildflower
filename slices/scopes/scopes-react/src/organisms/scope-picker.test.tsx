import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { type JSX, useMemo, useState } from 'react'
import { GrantDraft, ScopeRequest } from 'scopes-core'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { ScopePicker } from './scope-picker.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

/**
 * A minimal controlled host: the request is the all-optional envelope over `scopes`,
 * and the draft seeds every requested scope as granted (how every consent surface
 * mounts the picker).
 */
const Harness = ({ scopes }: { readonly scopes: readonly string[] }): JSX.Element => {
  const request = useMemo(() => ScopeRequest.fromRequestedScopes({ optional: scopes }), [scopes])
  const [draft, setDraft] = useState(() => GrantDraft.fromScopes(scopes, null))
  return (
    <ScopePicker
      subjectName="Fitbit Sync"
      request={request}
      draft={draft}
      onDraftChange={setDraft}
    />
  )
}

/** Render the picker over `scopes` and switch to the detail grid. */
const renderDetailView = async (scopes: readonly string[]): Promise<void> => {
  const user = userEvent.setup()
  render(<Harness scopes={scopes} />)
  await user.click(screen.getByRole('button', { name: /See exactly what/ }))
}

/**
 * A controlled host for the **expandable** (device-authorization) mode: the draft seeds the
 * requested scopes, but the picker may grant anything within `available`.
 */
const ExpandableHarness = ({
  requested,
  available,
}: {
  readonly requested: readonly string[]
  readonly available: readonly string[]
}): JSX.Element => {
  const request = useMemo(
    () => ScopeRequest.expandable({ requested, available }),
    [requested, available]
  )
  const [draft, setDraft] = useState(() => GrantDraft.fromScopes(requested, null))
  return (
    <ScopePicker
      subjectName="New device"
      request={request}
      draft={draft}
      onDraftChange={setDraft}
      mode="expandable"
    />
  )
}

/**
 * The answering surface's mounting: expandable, `asking` voice, with the account's
 * patients supplied for the which-patient choice. `available` covers `system/` so the
 * subject selector renders.
 */
const AskingHarness = ({
  scopes,
  patients,
}: {
  readonly scopes: readonly string[]
  readonly patients: readonly { readonly id: string; readonly displayName: string }[]
}): JSX.Element => {
  const request = useMemo(
    () => ScopeRequest.expandable({ requested: scopes, available: ['system/*.cruds'] }),
    [scopes]
  )
  const [draft, setDraft] = useState(() => GrantDraft.fromScopes(scopes, null))
  return (
    <ScopePicker
      subjectName="New device"
      request={request}
      draft={draft}
      onDraftChange={setDraft}
      mode="expandable"
      phrasing="asking"
      patients={patients}
    />
  )
}

describe('ScopePicker — plain statements', () => {
  it('should run the lead-ins subject → "It can also" → "…and"', () => {
    render(
      <Harness scopes={['patient/Observation.r', 'patient/Condition.r', 'patient/Encounter.r']} />
    )

    expect(screen.getByText('Fitbit Sync can')).toBeDefined()
    expect(screen.getByText('It can also')).toBeDefined()
    expect(screen.getByText('…and')).toBeDefined()
  })

  it('should untick an interaction through the statement picker', async () => {
    // Arrange — a single Observation read/search statement.
    const user = userEvent.setup()
    render(<Harness scopes={['patient/Observation.rs']} />)

    // Act — open the statement's picker and untick Read.
    await user.click(screen.getByRole('button', { name: /Read . Search/ }))
    const read = screen.getByRole<HTMLInputElement>('checkbox', { name: /Read/ })
    expect(read.checked).toBe(true)
    await user.click(read)

    // Assert — the control reflects the pruned draft.
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Read/ }).checked).toBe(false)
  })

  it('should disable an out-of-envelope interaction', async () => {
    // Arrange — only r/s were requested, so Create is outside the envelope.
    const user = userEvent.setup()
    render(<Harness scopes={['patient/Observation.rs']} />)
    await user.click(screen.getByRole('button', { name: /Read . Search/ }))

    // Assert
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Create/ }).disabled).toBe(true)
  })
})

describe('ScopePicker — view toggle', () => {
  it('should show the scope-string grid in detail view and hide it on return', async () => {
    const user = userEvent.setup()
    render(<Harness scopes={['patient/Observation.rs']} />)

    // The plain view carries no technical scope strings.
    expect(screen.queryByText('patient/Observation.rs')).toBeNull()

    // Act — switch to the detail grid.
    await user.click(screen.getByRole('button', { name: /See exactly what/ }))
    expect(screen.getByText('patient/Observation.rs')).toBeDefined()

    // Act — back to the summary.
    await user.click(screen.getByRole('button', { name: /Back to summary/ }))
    expect(screen.queryByText('patient/Observation.rs')).toBeNull()
  })
})

describe('ScopePicker — section titles (detail view)', () => {
  it('should read plain "Health records" for a single patient context', async () => {
    await renderDetailView(['patient/Observation.r'])
    expect(screen.getByRole('heading', { name: 'Health records' })).toBeDefined()
  })

  it('should always name all-patients for a lone system context', async () => {
    await renderDetailView(['system/Observation.r'])
    expect(screen.getByRole('heading', { name: 'Health records — all patients' })).toBeDefined()
  })

  it('should suffix patient and user when contexts are mixed', async () => {
    await renderDetailView(['patient/Observation.r', 'user/Encounter.r'])
    expect(screen.getByRole('heading', { name: 'Health records — this patient' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Health records — your access' })).toBeDefined()
  })

  it('should title a wildflower section "Wildflower admin" with the Admin chip', async () => {
    await renderDetailView(['wildflower/Client.r'])
    expect(screen.getByRole('heading', { name: 'Wildflower admin' })).toBeDefined()
    expect(screen.getByText('Admin')).toBeDefined()
  })
})

describe('ScopePicker — exclusions', () => {
  it('should render exclusion lines without an action affordance', () => {
    render(<Harness scopes={['patient/Observation.r']} />)

    // The informational line is present…
    expect(screen.getByText('Read or write other health record types')).toBeDefined()
    // …and carries no "+ Allow" / "Remove" affordance (`spec.md §8`).
    expect(screen.queryByRole('button', { name: '+ Allow' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })
})

describe('ScopePicker — statement wording', () => {
  it('should pluralize the resource in the running sentence', () => {
    render(<Harness scopes={['patient/Condition.r']} />)
    expect(screen.getByText('Conditions')).toBeDefined()
    expect(screen.queryByText(/^Condition$/)).toBeNull()
  })
})

describe('ScopePicker — expandable mode (device authorization)', () => {
  it('should land on the summary view with the subject selector and "+ Add rule"; clamped mode shows neither', () => {
    const { unmount } = render(
      <ExpandableHarness requested={['patient/Observation.r']} available={['system/*.cruds']} />
    )
    // Expandable mode defaults to the summary too — the detail-grid entry point is offered.
    expect(screen.getByRole('button', { name: /See exactly what/ })).toBeDefined()
    // The one-patient / all-patients subject selector (both radios).
    expect(screen.getByRole('radio', { name: /Just one patient/ })).toBeDefined()
    expect(screen.getByRole('radio', { name: /All patients/ })).toBeDefined()
    // The build-up affordance is already there in the summary view.
    expect(screen.getByRole('button', { name: '+ Add rule' })).toBeDefined()
    unmount()

    // Clamped mode: none of the expandable affordances appear.
    render(<Harness scopes={['patient/Observation.r']} />)
    expect(screen.queryByRole('radio', { name: /All patients/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '+ Add rule' })).toBeNull()
  })

  it('should grant an un-requested-but-allowed scope through "+ Add rule" (detail view)', async () => {
    const user = userEvent.setup()
    // Only Observation.r was requested; the client is allowed all of patient/*.
    render(
      <ExpandableHarness requested={['patient/Observation.r']} available={['system/*.cruds']} />
    )
    await user.click(screen.getByRole('button', { name: /See exactly what/ }))

    // Condition was never requested — it isn't a row yet.
    expect(screen.queryByRole('checkbox', { name: /Read Condition/ })).toBeNull()

    // Add the Condition rule, then read the freshly-surfaced row's Read cell.
    await user.click(screen.getByRole('button', { name: '+ Add rule' }))
    await user.click(screen.getByRole('option', { name: /Condition/ }))
    const readCondition = screen.getByRole<HTMLInputElement>('checkbox', { name: /Read Condition/ })
    expect(readCondition.getAttribute('aria-checked')).toBe('false')

    // Toggling it on records the expansion in the draft.
    await user.click(readCondition)
    expect(
      screen.getByRole('checkbox', { name: /Read Condition/ }).getAttribute('aria-checked')
    ).toBe('true')
  })

  it('should offer the * wildcard row under a covering system/* envelope (detail view)', async () => {
    const user = userEvent.setup()
    render(
      <ExpandableHarness requested={['patient/Observation.r']} available={['system/*.cruds']} />
    )
    await user.click(screen.getByRole('button', { name: /See exactly what/ }))

    // The patient section's "All records" wildcard row is grantable even though the
    // allowed set only carries the wildcard at the covering system context.
    const readAll = screen.getByRole<HTMLInputElement>('checkbox', { name: /Read Any Record/ })
    expect(readAll.getAttribute('aria-checked')).toBe('false')
    expect(readAll.disabled).toBe(false)
  })

  it('should switch the target FHIR context via the subject selector', async () => {
    const user = userEvent.setup()
    render(<ExpandableHarness requested={[]} available={['system/*.cruds']} />)

    // Lands on "just one patient" (spec §9) → the FHIR section names this patient…
    expect(
      screen.getByRole('radio', { name: /Just one patient/ }).getAttribute('aria-checked')
    ).toBe('true')
    // …switching to all-patients re-homes the section to the system context.
    await user.click(screen.getByRole('radio', { name: /All patients/ }))
    expect(screen.getByRole('heading', { name: 'Health records — all patients' })).toBeDefined()
  })

  it('should retire the wildcard exclusion once the draft grants the * row', async () => {
    const user = userEvent.setup()
    render(
      <ExpandableHarness requested={['patient/Observation.r']} available={['system/*.cruds']} />
    )
    expect(screen.getByText('Read or write other health record types')).toBeDefined()

    // Grant the wildcard through the detail grid — the exclusion line must retire.
    await user.click(screen.getByRole('button', { name: /See exactly what/ }))
    await user.click(screen.getByRole('checkbox', { name: /Read Any Record/ }))
    expect(screen.queryByText('Read or write other health record types')).toBeNull()
  })
})

describe('ScopePicker — summary section titles', () => {
  it('should segment the summary with the same headings as the detail grid', () => {
    render(<Harness scopes={['patient/Observation.r', 'wildflower/Client.r']} />)
    expect(screen.getByRole('heading', { name: 'Health records' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Wildflower admin' })).toBeDefined()
  })
})

describe('ScopePicker — asking phrasing', () => {
  it('should frame the ask and drop the possessive in asking voice', () => {
    render(
      <AskingHarness scopes={['patient/Observation.r', 'patient/Condition.r']} patients={[]} />
    )
    expect(screen.getByText('New device is asking to')).toBeDefined()
    expect(screen.getByText('It’s also asking to')).toBeDefined()
    expect(screen.queryByText('your')).toBeNull()
  })
})

describe('ScopePicker — requesting phrasing', () => {
  it('should lead with the first person and drop the possessive', () => {
    const request = ScopeRequest.expandable({
      requested: [],
      available: ['system/*.cruds'],
    })
    const Host = (): JSX.Element => {
      const [draft, setDraft] = useState(() =>
        GrantDraft.fromScopes(['patient/Observation.r'], null)
      )
      return (
        <ScopePicker
          subjectName="Ruth’s laptop"
          request={request}
          draft={draft}
          onDraftChange={setDraft}
          mode="expandable"
          phrasing="requesting"
        />
      )
    }
    render(<Host />)
    expect(screen.getByText('You’re requesting permission to')).toBeDefined()
    expect(screen.queryByText('your')).toBeNull()
  })
})

describe('ScopePicker — subject switch moves the selection', () => {
  it('should re-home the granted scopes when switching to all patients (no mixed contexts)', async () => {
    const user = userEvent.setup()
    render(<AskingHarness scopes={['patient/Observation.rs']} patients={[]} />)
    // A lone patient section titles plain "Health records".
    expect(screen.getByRole('heading', { name: 'Health records' })).toBeDefined()

    // Act — flip the subject; the whole selection follows.
    await user.click(screen.getByRole('radio', { name: /All patients/ }))

    // The one section re-homes to the system context — no patient-context leftovers
    // (a mixed pair would render two disambiguated headings instead).
    expect(screen.getByRole('heading', { name: 'Health records — all patients' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Health records' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Health records — this patient' })).toBeNull()
    // The moved statement still carries its granted verbs.
    expect(screen.getByRole('button', { name: /Read . Search/ })).toBeDefined()
  })
})

describe('ScopePicker — which-patient choice (answer side)', () => {
  it('should reveal the patient pill under "Just one patient" and record the pick', async () => {
    const user = userEvent.setup()
    render(
      <AskingHarness
        scopes={['patient/Observation.r']}
        patients={[{ id: 'p-1', displayName: 'Ada Lovelace' }]}
      />
    )

    // One-patient is the landing subject; the which-patient pill invites a choice.
    await user.click(screen.getByRole('button', { name: /Select a Patient/ }))
    await user.click(screen.getByRole('option', { name: /Ada Lovelace/ }))
    expect(screen.getByRole('button', { name: /Ada Lovelace/ })).toBeDefined()

    // All-patients has no single patient — the pill goes away.
    await user.click(screen.getByRole('radio', { name: /All patients/ }))
    expect(screen.queryByRole('button', { name: /Ada Lovelace/ })).toBeNull()
  })
})

describe('ScopePicker — flags', () => {
  it('should toggle a known flag off and back on', async () => {
    const user = userEvent.setup()
    render(<Harness scopes={['patient/Observation.r', 'openid']} />)

    const flag = screen.getByRole<HTMLInputElement>('switch', { name: /Confirm who you are/ })
    expect(flag.checked).toBe(true)

    await user.click(flag)
    expect(
      screen.getByRole<HTMLInputElement>('switch', { name: /Confirm who you are/ }).checked
    ).toBe(false)
  })

  it('should round-trip an unknown scope through its own toggle', async () => {
    const user = userEvent.setup()
    render(<Harness scopes={['x-custom-scope']} />)

    const unknown = screen.getByRole<HTMLInputElement>('switch', { name: /x-custom-scope/ })
    expect(unknown.checked).toBe(true)

    // Off, then back on — exercises value (not identity) matching in the draft.
    await user.click(unknown)
    expect(screen.getByRole<HTMLInputElement>('switch', { name: /x-custom-scope/ }).checked).toBe(
      false
    )
    await user.click(screen.getByRole('switch', { name: /x-custom-scope/ }))
    expect(screen.getByRole<HTMLInputElement>('switch', { name: /x-custom-scope/ }).checked).toBe(
      true
    )
  })
})
