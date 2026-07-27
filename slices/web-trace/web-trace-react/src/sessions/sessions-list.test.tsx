import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { TraceExchange } from 'web-trace-core'
import { traceExchange } from 'web-trace-core/test-helpers'

import { groupIntoSessions, type TraceSession } from './group-sessions.ts'
import { SessionsList, type SessionsListProps } from './sessions-list.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SessionsList', () => {
  it('should render one row per session, naming the session and its hosts', () => {
    // Arrange
    const sessions = sessionsFor([
      traceExchange({ sessionId: 'morning', requestId: 'a', url: 'https://portal.example.org/x' }),
      traceExchange({ sessionId: 'evening', requestId: 'b', url: 'https://api.example.com/y' }),
    ])

    // Act
    render(<SessionsList {...props({ sessions })} />)

    // Assert
    expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /portal\.example\.org/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /evening/ })).toBeDefined()
  })

  it('should report the session it was asked to open', async () => {
    // Arrange
    const onSelectSession = vi.fn()
    const sessions = sessionsFor([traceExchange({ sessionId: 'morning', requestId: 'a' })])
    render(<SessionsList {...props({ sessions, onSelectSession })} />)

    // Act
    await userEvent.click(screen.getByRole('button', { name: /morning/ }))

    // Assert
    expect(onSelectSession).toHaveBeenCalledWith('morning')
  })

  it('should mark exchange counts as a lower bound while more pages are outstanding', () => {
    // Arrange
    const sessions = sessionsFor([
      traceExchange({ sessionId: 'morning', requestId: 'a' }),
      traceExchange({ sessionId: 'morning', requestId: 'b' }),
    ])

    // Act
    render(<SessionsList {...props({ sessions, hasMore: true })} />)

    // Assert — a count over a partial read must not read as final
    expect(screen.getByText('2+ exchanges')).toBeDefined()
  })

  it('should report an exact exchange count once paging is done', () => {
    // Arrange
    const sessions = sessionsFor([
      traceExchange({ sessionId: 'morning', requestId: 'a' }),
      traceExchange({ sessionId: 'morning', requestId: 'b' }),
    ])

    // Act
    render(<SessionsList {...props({ sessions })} />)

    // Assert
    expect(screen.getByText('2 exchanges')).toBeDefined()
  })

  it('should say "1 exchange" only when that count is final', () => {
    // Arrange
    const sessions = sessionsFor([traceExchange({ sessionId: 'morning', requestId: 'a' })])
    const { unmount } = render(<SessionsList {...props({ sessions })} />)

    // Assert
    expect(screen.getByText('1 exchange')).toBeDefined()
    unmount()

    // Act — "1+" means at least one, so the noun stays plural
    render(<SessionsList {...props({ sessions, hasMore: true })} />)

    // Assert
    expect(screen.getByText('1+ exchanges')).toBeDefined()
  })

  it('should surface how many recordings could not be read', () => {
    // Act
    render(<SessionsList {...props({ unreadableCount: 3 })} />)

    // Assert — a dropped recording is reported, never silently omitted
    expect(screen.getByText('3 recordings could not be read')).toBeDefined()
  })

  it('should say nothing about unreadable recordings when there are none', () => {
    // Act
    render(<SessionsList {...props({ unreadableCount: 0 })} />)

    // Assert
    expect(screen.queryByText(/could not be read/)).toBeNull()
  })

  it('should say the device holds no recordings when there are none', () => {
    // Act
    render(<SessionsList {...props({})} />)

    // Assert
    expect(screen.getByText('No recordings on this device.')).toBeDefined()
  })

  it('should offer to load more only while the server reported another page', async () => {
    // Arrange
    const onLoadMore = vi.fn()
    const sessions = sessionsFor([traceExchange({ sessionId: 'morning', requestId: 'a' })])
    const { unmount } = render(<SessionsList {...props({ sessions })} />)

    // Assert — nothing to load
    expect(screen.queryByRole('button', { name: 'Load more recordings' })).toBeNull()
    unmount()

    // Act
    render(<SessionsList {...props({ sessions, hasMore: true, onLoadMore })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Load more recordings' }))

    // Assert
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('should not let a second page be requested while one is in flight', () => {
    // Arrange
    const sessions = sessionsFor([traceExchange({ sessionId: 'morning', requestId: 'a' })])

    // Act
    render(<SessionsList {...props({ sessions, hasMore: true, isLoadingMore: true })} />)

    // Assert
    const button = screen.getByRole('button', { name: 'Loading…' })
    expect(button).toHaveProperty('disabled', true)
  })
})

// Helpers

/** Real sessions, built through the same grouping that feeds the component in production. */
const sessionsFor = (exchanges: readonly TraceExchange[]): readonly TraceSession[] =>
  groupIntoSessions(exchanges)

/** Every prop at its resting value, so each test states only what it is about. */
const props = (overrides: Partial<SessionsListProps>): SessionsListProps => ({
  sessions: [],
  onSelectSession: (): void => {},
  hasMore: false,
  isLoadingMore: false,
  onLoadMore: (): void => {},
  unreadableCount: 0,
  ...overrides,
})
