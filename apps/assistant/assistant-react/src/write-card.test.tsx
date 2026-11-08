import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WriteProposal } from '@wildflowerhealthio/assistant-core-js'
import { Option } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { WriteCard } from './write-card.tsx'

afterEach(cleanup)

const create: WriteProposal.Type = {
  kind: 'create',
  callId: 'call-1',
  resource: {
    resourceType: 'Observation',
    status: 'final',
    subject: { reference: 'Patient/p1' },
  },
}

const update: WriteProposal.Type = {
  kind: 'update',
  callId: 'call-2',
  resource: { resourceType: 'Observation', id: 'o1', status: 'entered-in-error' },
  versionId: '3',
  fields: [
    {
      path: ['status'],
      server: { _tag: 'value', value: 'final' },
      incoming: { _tag: 'value', value: 'entered-in-error' },
    },
    {
      path: ['note'],
      server: { _tag: 'absent' },
      incoming: { _tag: 'value', value: 'Wrong patient' },
    },
    {
      path: ['valueQuantity'],
      server: { _tag: 'value', value: { value: 70 } },
      incoming: { _tag: 'absent' },
    },
  ],
}

describe('WriteCard', () => {
  it('should show a new record field by field, and approve it', async () => {
    const user = userEvent.setup()
    const onDecide = vi.fn<(decision: WriteProposal.Decision) => void>()
    render(<WriteCard proposal={create} decision={Option.none()} onDecide={onDecide} />)

    expect(screen.getByText('Create Observation')).toBeDefined()
    expect(screen.getByText('status').nextElementSibling?.textContent).toBe('"final"')
    expect(screen.getByText('subject').nextElementSibling?.textContent).toBe(
      '{"reference":"Patient/p1"}'
    )
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    expect(onDecide.mock.calls).toEqual([[{ kind: 'approved' }]])
  })

  it('should show an update as fields added, changed and removed', () => {
    render(<WriteCard proposal={update} decision={Option.none()} onDecide={() => undefined} />)

    const lines = screen.getAllByRole('listitem').map(({ textContent }) => textContent)
    expect(screen.getByText('Update Observation/o1, 3 fields')).toBeDefined()
    expect(lines).toEqual([
      'Changedstatus"final"→"entered-in-error"',
      'Addednote(absent)→"Wrong patient"',
      'RemovedvalueQuantity{"value":70}→(absent)',
    ])
  })

  it('should ask for an optional reason above the buttons before declining, and pass it on', async () => {
    const user = userEvent.setup()
    const onDecide = vi.fn<(decision: WriteProposal.Decision) => void>()
    render(<WriteCard proposal={update} decision={Option.none()} onDecide={onDecide} />)

    expect(screen.queryByLabelText('Reason (optional)')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Decline' }))
    const reason = screen.getByLabelText('Reason (optional)')
    const confirm = screen.getByRole('button', { name: 'Decline change' })
    expect(reason.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(onDecide).not.toHaveBeenCalled()
    await user.type(reason, '  It was the right patient  ')
    await user.click(confirm)

    expect(onDecide.mock.calls).toEqual([
      [{ kind: 'declined', reason: Option.some('It was the right patient') }],
    ])
  })

  it('should decline with no reason when none is given', async () => {
    const user = userEvent.setup()
    const onDecide = vi.fn<(decision: WriteProposal.Decision) => void>()
    render(<WriteCard proposal={update} decision={Option.none()} onDecide={onDecide} />)

    await user.click(screen.getByRole('button', { name: 'Decline' }))
    await user.click(screen.getByRole('button', { name: 'Decline change' }))

    expect(onDecide.mock.calls).toEqual([[{ kind: 'declined', reason: Option.none() }]])
  })

  it('should show the decision in place of the buttons once made', () => {
    render(
      <WriteCard
        proposal={create}
        decision={Option.some({ kind: 'approved' })}
        onDecide={() => undefined}
      />
    )

    expect(screen.getByRole('status').textContent).toBe('Approved. Saving…')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
