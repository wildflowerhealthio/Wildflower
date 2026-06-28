import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { Envelope, Fhir, Grant, Scope } from 'scopes-core'
import { AccessRights, Bucket } from 'scopes-core'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { buildGridRows } from './grid-model.ts'
import { PermissionGrid } from './permission-grid.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const patient = Bucket.fhir('patient')
const grant = (scopes: Scope.Any[]): Grant.Any => ({ subject: 'jordan', scopes })

const patientFhir = (name: string, access = AccessRights.letters(['r'])): Fhir.Any => ({
  kind: 'fhir',
  context: 'patient',
  resource: name === '*' ? { kind: 'wildcard' } : { kind: 'known', name },
  access,
})

describe('PermissionGrid', () => {
  it('renders the five CRUDS columns and a cell per action', () => {
    const rows = buildGridRows({
      grant: grant([patientFhir('Observation', AccessRights.letters(['r']))]),
      envelope: null,
      bucket: patient,
      resources: ['Observation'],
    })
    render(
      <PermissionGrid
        title="Health records"
        rows={rows}
        onToggleCell={vi.fn()}
        onToggleWord={vi.fn()}
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
    const onToggleCell = vi.fn()
    const user = userEvent.setup()
    // patient/*.r locks Read on every specific row.
    const rows = buildGridRows({
      grant: grant([
        patientFhir('*', AccessRights.letters(['r'])),
        patientFhir('Observation', AccessRights.letters([])),
      ]),
      envelope: null,
      bucket: patient,
      resources: ['Observation'],
      includeWildcard: false,
    })
    render(
      <PermissionGrid
        title="Health records"
        rows={rows}
        onToggleCell={onToggleCell}
        onToggleWord={vi.fn()}
      />
    )

    // Locked cells fold the reason into the accessible name.
    const readCell = screen.getByRole('checkbox', { name: /^Read Observation/ })
    expect(readCell.getAttribute('aria-checked')).toBe('true')
    expect(readCell.getAttribute('aria-label')).toContain('All record types')
    await user.click(readCell) // locked → no-op
    expect(onToggleCell).not.toHaveBeenCalled()

    await user.click(screen.getByRole('checkbox', { name: 'Create Observation' }))
    expect(onToggleCell).toHaveBeenCalledWith(patient, 'Observation', 'c')
  })

  it('renders a v1 word row as a Read/Write multiselect instead of CRUDS cells', async () => {
    const onToggleWord = vi.fn()
    const user = userEvent.setup()
    const envelope: Envelope.Any = {
      resources: [patientFhir('Observation', AccessRights.star)],
      flags: [],
    }
    const rows = buildGridRows({
      grant: grant([patientFhir('Observation', AccessRights.read)]),
      envelope,
      bucket: patient,
      resources: ['Observation'],
    })
    render(
      <PermissionGrid
        title="Health records"
        rows={rows}
        onToggleCell={vi.fn()}
        onToggleWord={onToggleWord}
      />
    )

    // No CRUDS cell named "Read Observation" — the row is the Read/Write picker.
    expect(screen.queryByRole('checkbox', { name: 'Read Observation' })).toBeNull()
    const read = screen.getByRole<HTMLInputElement>('checkbox', { name: /Read/ })
    const write = screen.getByRole<HTMLInputElement>('checkbox', { name: /Write/ })
    expect(read.checked).toBe(true) // grant is patient/Observation.read
    expect(write.checked).toBe(false)

    await user.click(write)
    expect(onToggleWord).toHaveBeenCalledWith(patient, 'Observation', 'write')
  })
})
