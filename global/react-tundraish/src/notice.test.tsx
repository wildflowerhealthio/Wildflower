import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { Notice } from './notice.tsx'

afterEach(() => {
  cleanup()
})

describe('Notice', () => {
  it('says a danger message in an alert, after a hidden glyph and the word Error', () => {
    render(<Notice tone="danger">The files could not be read.</Notice>)

    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('The files could not be read.')).toBeDefined()
    expect(alert.querySelector('.sr-only')?.textContent).toBe('Error: ')
    expect(alert.querySelector('[aria-hidden="true"]')?.textContent).toBe('⚠')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says a success message in a status region, after a hidden glyph and the word Success', () => {
    render(<Notice tone="success">4 new, 0 updated, 0 linked.</Notice>)

    const status = screen.getByRole('status')
    expect(within(status).getByText('4 new, 0 updated, 0 linked.')).toBeDefined()
    expect(status.querySelector('.sr-only')?.textContent).toBe('Success: ')
    expect(status.querySelector('[aria-hidden="true"]')?.textContent).toBe('✓')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders the action as a link button after the message and fires it', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Notice tone="danger" action={{ label: 'Choose other files', onClick }}>
        Nothing was imported.
      </Notice>
    )

    const button = within(screen.getByRole('alert')).getByRole('button', {
      name: 'Choose other files',
    })
    expect(button.closest('p')?.textContent).toBe('Error: Nothing was imported. Choose other files')
    await user.click(button)

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders no button without an action', () => {
    render(<Notice tone="success">Done.</Notice>)

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders the details under the message, outside it', () => {
    render(
      <Notice
        tone="danger"
        details={
          <ul>
            <li>Transaction failed at entry 0</li>
          </ul>
        }
      >
        No records were written.
      </Notice>
    )

    const alert = screen.getByRole('alert')
    const item = within(alert).getByRole('listitem')
    expect(item.textContent).toBe('Transaction failed at entry 0')
    expect(item.closest('p')).toBeNull()
  })

  it('passes its root props through, adding its class to the caller’s', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <Notice tone="success" id="done" data-anchor="notice" className="extra" ref={ref}>
        Done.
      </Notice>
    )

    const status = screen.getByRole('status')
    expect(ref.current).toBe(status)
    expect(status.id).toBe('done')
    expect(status.dataset['anchor']).toBe('notice')
    expect(status.classList.contains('extra')).toBe(true)
    expect(status.classList.length).toBeGreaterThan(1)
  })
})
