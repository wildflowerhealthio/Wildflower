import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { FieldChecklist, type FieldChecklistField } from './field-checklist.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

type FieldId = 'name' | 'birthDate' | 'identifier'

const fieldsTicked = (
  name: boolean,
  birthDate: boolean
): readonly FieldChecklistField<FieldId>[] => [
  {
    id: 'name',
    name: 'name',
    from: 'Dr. Brown',
    to: 'Dr. Jonathan Brown',
    fillsGap: true,
    checked: name,
  },
  {
    id: 'birthDate',
    name: 'birthDate',
    from: null,
    to: '1961-04-02',
    fillsGap: true,
    checked: birthDate,
  },
  {
    id: 'identifier',
    name: 'identifier',
    from: null,
    to: '9876543',
    fillsGap: true,
    alwaysTakenReason: 'always kept, so both files match later',
  },
]

const getCheckbox = (name: RegExp): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('checkbox', { name })

const parentState = (): { checked: boolean; indeterminate: boolean } => {
  const parent = getCheckbox(/^Update with import details/)
  return { checked: parent.checked, indeterminate: parent.indeterminate }
}

describe('FieldChecklist', () => {
  // First-render React Testing Library setup (jsdom environment + render) can
  // exceed the 5s default under the CPU contention of `vp run -r test`.
  it('checks the parent when every field the reader can tick is ticked', () => {
    // Act
    render(
      <FieldChecklist
        label="Update with import details"
        fields={fieldsTicked(true, true)}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
      />
    )

    // Assert
    expect(parentState()).toEqual({ checked: true, indeterminate: false })
  }, 15_000)

  it('shows the parent partly checked when only some fields are ticked', () => {
    // Act
    render(
      <FieldChecklist
        label="Update with import details · 1 of 2"
        fields={fieldsTicked(true, false)}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
      />
    )

    // Assert
    expect(parentState()).toEqual({ checked: false, indeterminate: true })
  })

  it('leaves the parent empty when no field is ticked, though one is always taken', () => {
    // Act
    render(
      <FieldChecklist
        label="Update with import details"
        fields={fieldsTicked(false, false)}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
      />
    )

    // Assert
    expect(parentState()).toEqual({ checked: false, indeterminate: false })
  })

  it('ticks every field from a partly checked parent, and clears them from a checked one', async () => {
    // Arrange
    const onToggleAll = vi.fn<(checked: boolean) => void>()
    const user = userEvent.setup()
    const { rerender } = render(
      <FieldChecklist
        label="Update with import details"
        fields={fieldsTicked(true, false)}
        onToggle={vi.fn()}
        onToggleAll={onToggleAll}
      />
    )
    await user.click(getCheckbox(/^Update with import details/))
    rerender(
      <FieldChecklist
        label="Update with import details"
        fields={fieldsTicked(true, true)}
        onToggle={vi.fn()}
        onToggleAll={onToggleAll}
      />
    )

    // Act
    await user.click(getCheckbox(/^Update with import details/))

    // Assert
    expect(onToggleAll.mock.calls).toEqual([[true], [false]])
  })

  it('hands back the field and its next state when the reader ticks it', async () => {
    // Arrange
    const onToggle = vi.fn<(id: FieldId, checked: boolean) => void>()
    const user = userEvent.setup()
    render(
      <FieldChecklist
        label="Update with import details"
        fields={fieldsTicked(true, false)}
        onToggle={onToggle}
        onToggleAll={vi.fn()}
      />
    )

    // Act
    await user.click(getCheckbox(/^birthDate/))

    // Assert
    expect(onToggle).toHaveBeenCalledExactlyOnceWith('birthDate', true)
  })

  it('reads each field as its change, with an always-taken field checked and disabled', () => {
    // Act
    render(
      <FieldChecklist
        label="Take from lifelabs.pdf"
        fields={fieldsTicked(true, false)}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
      />
    )

    // Assert
    const identifier = getCheckbox(/^identifier/)
    expect(screen.getAllByRole('checkbox').map((box) => box.parentElement?.textContent)).toEqual([
      'Take from lifelabs.pdf',
      'name Dr. Brown → Dr. Jonathan Brown',
      'birthDate gains 1961-04-02',
      'identifier gains 9876543 · always kept, so both files match later',
    ])
    expect({ checked: identifier.checked, disabled: identifier.disabled }).toEqual({
      checked: true,
      disabled: true,
    })
  })
})
