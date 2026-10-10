import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { LoadingLine, LoadingMoreLine, ReadFailureLine } from './read-status-lines.tsx'

afterEach(() => {
  cleanup()
})

describe('LoadingLine', () => {
  it('says Loading… with no subject', () => {
    render(<LoadingLine />)
    expect(screen.getByText('Loading…')).toBeDefined()
  })

  it('names its subject', () => {
    render(<LoadingLine subject="medications" />)
    expect(screen.getByText('Loading medications…')).toBeDefined()
  })
})

describe('LoadingMoreLine', () => {
  it('says Loading more…', () => {
    render(<LoadingMoreLine />)
    expect(screen.getByText('Loading more…')).toBeDefined()
  })
})

describe('ReadFailureLine', () => {
  it("names the subject and an Error's message", () => {
    render(<ReadFailureLine subject="observations" error={new Error('search failed')} />)
    expect(screen.getByText('Could not load observations: search failed')).toBeDefined()
  })

  it('names a thrown non-Error as a string', () => {
    render(<ReadFailureLine subject="patients" error="timed out" />)
    expect(screen.getByText('Could not load patients: timed out')).toBeDefined()
  })
})
