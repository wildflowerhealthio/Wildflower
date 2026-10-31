import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { RadioCard, RadioCardGroup } from './radio-card.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const getRadio = (name: string): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('radio', { name })

/** Two cards and a plain line in one group, holding the picked value itself. */
const Harness = ({ onSelect }: { readonly onSelect: (value: string) => void }): JSX.Element => {
  const [picked, setPicked] = useState<string | null>(null)
  const pick = (value: string): void => {
    setPicked(value)
    onSelect(value)
  }
  return (
    <RadioCardGroup aria-label="Patient record for Tyra Ashford">
      <RadioCard
        name="match"
        value="create"
        checked={picked === 'create'}
        onSelect={() => {
          pick('create')
        }}
        label="Save as a new record"
        variant="dashed"
      >
        <span>Tyra Ashford</span>
      </RadioCard>
      <RadioCard
        name="match"
        value="existing"
        checked={picked === 'existing'}
        onSelect={() => {
          pick('existing')
        }}
        label="Use this existing record"
        outcome="22 records will reference this record instead."
        tray={
          <>
            <button type="button">Show differences</button>
            <label>
              <input type="checkbox" onChange={() => undefined} />
              birthDate
            </label>
          </>
        }
      >
        <span>Tyra A. Ashford</span>
        <dialog open={true}>
          <p>Tyra A. Ashford, born 1990</p>
        </dialog>
        {createPortal(<p>Portalled note</p>, document.body)}
      </RadioCard>
      <label>
        <input
          type="radio"
          name="match"
          value="skip"
          checked={picked === 'skip'}
          onChange={() => {
            pick('skip')
          }}
        />
        Don&apos;t add
      </label>
    </RadioCardGroup>
  )
}

describe('RadioCard', () => {
  // First-render React Testing Library setup (jsdom environment + render) can
  // exceed the 5s default under the CPU contention of `vp run -r test`.
  it('puts every card and line in one named radio group', () => {
    // Act
    render(<Harness onSelect={vi.fn()} />)

    // Assert
    const group = screen.getByRole('radiogroup', { name: 'Patient record for Tyra Ashford' })
    expect(
      Array.from(
        group.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
        (input) => input.name
      )
    ).toEqual(['match', 'match', 'match'])
  }, 15_000)

  it('picks the card when the reader clicks its evidence', async () => {
    // Arrange
    const onSelect = vi.fn<(value: string) => void>()
    const user = userEvent.setup()
    render(<Harness onSelect={onSelect} />)

    // Act
    await user.click(screen.getByText('Tyra A. Ashford'))

    // Assert
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('existing')
    expect(getRadio('Use this existing record').checked).toBe(true)
  })

  it('picks the card once when the reader clicks its radio label', async () => {
    // Arrange
    const onSelect = vi.fn<(value: string) => void>()
    const user = userEvent.setup()
    render(<Harness onSelect={onSelect} />)

    // Act
    await user.click(screen.getByText('Save as a new record'))

    // Assert
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('create')
  })

  it('leaves the pick to a control inside the card that answers the click', async () => {
    // Arrange
    const onSelect = vi.fn<(value: string) => void>()
    const user = userEvent.setup()
    render(<Harness onSelect={onSelect} />)

    // Act
    await user.click(screen.getByRole('button', { name: 'Show differences' }))

    // Assert — the click reached the card, but the button inside it owns it.
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByText('22 records will reference this record instead.')).toBeDefined()
  })

  it('leaves the pick alone for a click inside a dialog or a portal from the card', async () => {
    // Arrange
    const onSelect = vi.fn<(value: string) => void>()
    const user = userEvent.setup()
    render(<Harness onSelect={onSelect} />)

    // Act
    await user.click(screen.getByText('Tyra A. Ashford, born 1990'))
    await user.click(screen.getByText('Portalled note'))

    // Assert
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('picks the card when the reader changes a control in its tray', async () => {
    // Arrange
    const onSelect = vi.fn<(value: string) => void>()
    const user = userEvent.setup()
    render(<Harness onSelect={onSelect} />)

    // Act
    await user.click(screen.getByRole('checkbox', { name: 'birthDate' }))

    // Assert
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('existing')
    expect(getRadio('Use this existing record').checked).toBe(true)
  })

  it('does not pick a card again once it is picked', async () => {
    // Arrange
    const onSelect = vi.fn<(value: string) => void>()
    const user = userEvent.setup()
    render(<Harness onSelect={onSelect} />)
    await user.click(screen.getByText('Tyra Ashford'))

    // Act
    await user.click(screen.getByText('Tyra Ashford'))

    // Assert
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('create')
  })

  it('moves the pick between cards and the plain line with the arrow keys', async () => {
    // Arrange
    const onSelect = vi.fn<(value: string) => void>()
    const user = userEvent.setup()
    render(<Harness onSelect={onSelect} />)
    await user.click(getRadio('Save as a new record'))

    // Act
    await user.keyboard('{ArrowDown}{ArrowDown}')

    // Assert
    expect(onSelect.mock.calls).toEqual([['create'], ['existing'], ['skip']])
    expect(getRadio("Don't add").checked).toBe(true)
  })
})
