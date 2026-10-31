import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { Chip } from './chip.tsx'
import { RecordRow, type RecordRowChoice } from './record-row.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

type Choice = 'use' | 'create' | 'skip'

const choices: readonly RecordRowChoice<Choice>[] = [
  { value: 'use', label: 'Use Dr. Brown', tone: 'neutral' },
  { value: 'create', label: 'Save as a new record', tone: 'accent' },
  { value: 'skip', label: "Don't add", tone: 'muted' },
]

const getSelect = (): HTMLSelectElement =>
  screen.getByRole<HTMLSelectElement>('combobox', { name: 'On import: Dr. Brown' })

const lines = {
  title: 'Dr. Brown',
  detail: 'identifier 1234567',
  reason: 'Identifier match · same as existing',
  placeholder: 'Select…',
} as const

describe('RecordRow', () => {
  // First-render React Testing Library setup (jsdom environment + render) can
  // exceed the 5s default under the CPU contention of `vp run -r test`.
  it('shows its three lines and its picked choice', () => {
    // Act
    render(
      <RecordRow
        {...lines}
        badge={<Chip>Changed</Chip>}
        choices={choices}
        choice="use"
        onChoose={vi.fn()}
        choiceLabel="On import: Dr. Brown"
      />
    )

    // Assert
    expect(screen.getByText('Changed')).toBeDefined()
    expect(screen.getByText('identifier 1234567')).toBeDefined()
    expect(screen.getByText('Identifier match · same as existing')).toBeDefined()
    expect(getSelect().value).toBe('use')
    expect(Array.from(getSelect().options, (option) => option.text)).toEqual([
      'Use Dr. Brown',
      'Save as a new record',
      "Don't add",
    ])
  }, 15_000)

  it('hands back the option the reader picks', async () => {
    // Arrange
    const onChoose = vi.fn<(value: Choice) => void>()
    const user = userEvent.setup()
    render(
      <RecordRow
        {...lines}
        choices={choices}
        choice="use"
        onChoose={onChoose}
        choiceLabel="On import: Dr. Brown"
      />
    )

    // Act
    await user.selectOptions(getSelect(), 'skip')

    // Assert
    expect(onChoose).toHaveBeenCalledExactlyOnceWith('skip')
  })

  it('leads with a disabled placeholder while nothing is picked', () => {
    // Act
    render(
      <RecordRow
        {...lines}
        choices={choices}
        choice={null}
        onChoose={vi.fn()}
        choiceLabel="On import: Dr. Brown"
      />
    )

    // Assert
    const [first] = getSelect().options
    expect({ value: getSelect().value, text: first?.text, disabled: first?.disabled }).toEqual({
      value: '',
      text: 'Select…',
      disabled: true,
    })
  })

  it('falls back to the placeholder when the choice is not among the options', async () => {
    // Arrange
    const onChoose = vi.fn<(value: Choice) => void>()
    const user = userEvent.setup()
    render(
      <RecordRow
        {...lines}
        choices={choices.filter((option) => option.value !== 'use')}
        choice="use"
        onChoose={onChoose}
        choiceLabel="On import: Dr. Brown"
      />
    )

    // Act
    await user.selectOptions(getSelect(), 'create')

    // Assert — the stale choice reads as unpicked, so its first real option can still be picked.
    expect(Array.from(getSelect().options, (option) => option.text)).toEqual([
      'Select…',
      'Save as a new record',
      "Don't add",
    ])
    expect(onChoose).toHaveBeenCalledExactlyOnceWith('create')
  })

  it('opens the record from its text and resets it from its Reset link', async () => {
    // Arrange
    const onOpen = vi.fn()
    const onReset = vi.fn()
    const user = userEvent.setup()
    render(
      <RecordRow
        {...lines}
        choices={choices}
        choice="create"
        onChoose={vi.fn()}
        choiceLabel="On import: Dr. Brown"
        onOpen={onOpen}
        onReset={onReset}
      />
    )

    // Act
    await user.click(screen.getByRole('button', { name: /^Dr\. Brown/ }))
    await user.click(screen.getByRole('button', { name: 'Reset' }))

    // Assert
    expect([onOpen.mock.calls.length, onReset.mock.calls.length]).toEqual([1, 1])
  })

  it('renders its text as plain content when there is nothing to open', () => {
    // Act
    render(
      <RecordRow
        {...lines}
        choices={choices}
        choice="create"
        onChoose={vi.fn()}
        choiceLabel="On import: Dr. Brown"
      />
    )

    // Assert — the select is the row's only control.
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(getSelect()).toBeDefined()
  })
})
