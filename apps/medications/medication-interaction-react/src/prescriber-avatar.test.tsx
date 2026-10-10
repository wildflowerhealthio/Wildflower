import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { PrescriberAvatar } from './prescriber-avatar.tsx'

afterEach(cleanup)

describe('PrescriberAvatar', () => {
  it('should show up to two initials and the full "Dr." name as its label', () => {
    render(<PrescriberAvatar name="Jane Smith" />)
    const avatar = screen.getByRole('img', { name: 'Dr. Jane Smith' })
    expect(avatar.textContent).toBe('JS')
  })

  it('should use a single initial for a one-word name', () => {
    render(<PrescriberAvatar name="Smith" />)
    expect(screen.getByRole('img', { name: 'Dr. Smith' }).textContent).toBe('S')
  })

  it('should fall back to a neutral "?" when the prescriber is unknown', () => {
    render(<PrescriberAvatar name={null} />)
    expect(screen.getByRole('img', { name: 'Prescriber unknown' }).textContent).toBe('?')
  })

  it('should treat a blank name as unknown', () => {
    render(<PrescriberAvatar name="   " />)
    expect(screen.getByRole('img', { name: 'Prescriber unknown' }).textContent).toBe('?')
  })

  it('should announce a different prescriber in the label when ringed', () => {
    render(<PrescriberAvatar name="Bob Jones" ringed />)
    expect(screen.getByRole('img', { name: 'Dr. Bob Jones — different prescriber' })).toBeDefined()
  })

  it('should paint the same name the same colour every time', () => {
    render(
      <>
        <PrescriberAvatar name="Jane Smith" />
        <PrescriberAvatar name="Jane Smith" />
      </>
    )
    const [first, second] = screen.getAllByRole('img')
    expect(first?.className).toBe(second?.className)
  })
})
