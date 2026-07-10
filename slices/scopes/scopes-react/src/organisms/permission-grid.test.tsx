import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import {
  Grant,
  type GrantDraft,
  Rows,
  Scope,
  type ScopeRequest,
  type ResourceSection,
} from 'scopes-core'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { PermissionGrid } from './permission-grid.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const patient = Scope.Contexts.Fhir.patient
const observation = Scope.ResourceType.Fhir.parse('Observation')!
const v2Section: ResourceSection.ResourceSection<'fhirV2'> = {
  kind: 'fhirV2',
  configuration: Scope.FhirV2.configuration,
  context: patient,
  resources: [observation],
}
const v1Section: ResourceSection.ResourceSection<'fhirV1'> = {
  kind: 'fhirV1',
  configuration: Scope.FhirV1.configuration,
  context: patient,
  resources: [observation],
}

/** A one-patient draft over the given wire scope strings — the single source of truth (§5). */
const draft = (scopes: string[]): GrantDraft.GrantDraft => ({
  patient: 'jordan',
  ...Grant.parse(scopes),
})

/** A request-mode envelope from wire scope strings. */
const request = (requested: string[], required: string[] = []): ScopeRequest.ScopeRequest => ({
  requested: Grant.parse(requested),
  required: Grant.parse(required),
})

describe('PermissionGrid', () => {
  it('renders the interaction columns and a cell per interaction', () => {
    const rows = Rows.build(v2Section, draft(['patient/Observation.r']), null)

    render(
      <PermissionGrid
        title="Health records"
        section={v2Section}
        rows={rows}
        onToggleItem={vi.fn()}
      />
    )

    expect(screen.getByRole('columnheader', { name: /Create/ })).toBeDefined()
    // Read is granted → that cell is checked.
    expect(
      screen
        .getByRole<HTMLElement>('checkbox', { name: 'Read Observation' })
        .getAttribute('aria-checked')
    ).toBe('true')
  }, 15_000)

  it('toggles an editable cell but not a wildcard-locked one', async () => {
    const onToggleItem = vi.fn()
    const user = userEvent.setup()
    // patient/*.r locks Read on every specific row.
    const rows = Rows.build(v2Section, draft(['patient/*.r', 'patient/Observation.cruds']), null)

    render(
      <PermissionGrid
        title="Health records"
        section={v2Section}
        rows={rows}
        onToggleItem={onToggleItem}
      />
    )

    // Locked cells fold the reason into the accessible name.
    const readCell = screen.getByRole('checkbox', { name: /^Read Observation/ })
    expect(readCell.getAttribute('aria-checked')).toBe('true')
    expect(readCell.getAttribute('aria-label')).toContain('all medical record types')
    await user.click(readCell) // locked → no-op
    expect(onToggleItem).not.toHaveBeenCalled()

    await user.click(screen.getByRole('checkbox', { name: 'Create Observation' }))
    expect(onToggleItem).toHaveBeenCalledWith(Scope.ResourceType.Fhir.parse('Observation'), 'c')
  })

  it('renders a v1 word row as a Read/Write multiselect instead of interaction cells', async () => {
    const onToggleItem = vi.fn()
    const user = userEvent.setup()
    const rows = Rows.build(
      v1Section,
      draft(['patient/Observation.read']),
      request(['patient/Observation.*'])
    )

    render(
      <PermissionGrid
        title="Health records"
        section={v1Section}
        rows={rows}
        onToggleItem={onToggleItem}
      />
    )

    // No interaction cell named "Read Observation" — the row is the Read/Write picker.
    expect(screen.queryByRole('checkbox', { name: 'Read Observation' })).toBeNull()
    const read = screen.getByRole<HTMLInputElement>('checkbox', { name: /Read/ })
    const write = screen.getByRole<HTMLInputElement>('checkbox', { name: /Write/ })
    expect(read.checked).toBe(true) // grant is patient/Observation.read
    expect(write.checked).toBe(false)

    await user.click(write)
    expect(onToggleItem).toHaveBeenCalledWith(Scope.ResourceType.Fhir.parse('Observation'), 'write')
  })
})
