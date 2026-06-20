import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { TextField } from './text-field.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TextField', () => {
  // First-render React Testing Library setup (jsdom environment + render) can
  // exceed the 5s default under the CPU contention of `vp run -r test`. Bumped
  // for headroom; cheap once the renderer has warmed up for later tests.
  it('associates the label with the input so getByLabelText resolves it', () => {
    render(<TextField label="Public host" value="example.com" onChange={vi.fn()} />)

    const input = screen.getByLabelText('Public host')
    if (!(input instanceof HTMLInputElement)) throw new Error('expected <input>')
    expect(input.value).toBe('example.com')
  }, 15_000)

  it('fires onChange with the new string as the user types', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<TextField label="Name" value="" onChange={onChange} />)

    await user.type(screen.getByLabelText('Name'), 'ab')

    // userEvent.type fires one change per character.
    expect(onChange).toHaveBeenNthCalledWith(1, 'a')
    expect(onChange).toHaveBeenNthCalledWith(2, 'b')
  })

  it('renders the description beneath the input when provided', () => {
    render(
      <TextField
        label="Token"
        value=""
        onChange={vi.fn()}
        description="Never shown — enter a new token to change the connection."
      />
    )

    expect(
      screen.getByText('Never shown — enter a new token to change the connection.')
    ).toBeTruthy()
  })

  it('adds the callout accent class on the input when callout is true', () => {
    render(<TextField label="Token" value="" onChange={vi.fn()} callout />)

    const input = screen.getByLabelText('Token')
    if (!(input instanceof HTMLInputElement)) throw new Error('expected <input>')
    // Class is CSS-modules-hashed; check for the unhashed token name.
    expect(input.className).toMatch(/callout/)
  })

  it('omits the callout class by default', () => {
    render(<TextField label="Host" value="" onChange={vi.fn()} />)

    const input = screen.getByLabelText('Host')
    if (!(input instanceof HTMLInputElement)) throw new Error('expected <input>')
    expect(input.className).not.toMatch(/callout/)
  })

  it('disables the input when disabled is true', () => {
    render(<TextField label="Host" value="frozen" onChange={vi.fn()} disabled />)

    const input = screen.getByLabelText('Host')
    if (!(input instanceof HTMLInputElement)) throw new Error('expected <input>')
    expect(input.disabled).toBe(true)
  })

  it('honors a provided id rather than the auto-generated one', () => {
    render(<TextField id="custom-id" label="Host" value="" onChange={vi.fn()} />)

    expect(screen.getByLabelText('Host').getAttribute('id')).toBe('custom-id')
  })
})
