import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { TraceExchange } from 'web-trace-core'
import { traceExchange } from 'web-trace-core/test-helpers'

import { ExchangeList } from './exchange-list.tsx'
import { NO_FILTERS, type ExchangeFilters } from './filter-exchanges.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ExchangeList', () => {
  it('should render captured URLs exactly as recorded, unredacted', () => {
    // Arrange — an identifier in the path and a patient name in the query are
    // exactly the values the export flow pseudonymizes. The viewer is the
    // user's own device showing the user's own data, so it shows them as-is.
    const url =
      'https://portal.example.org/api/v2/patients/8f14e45f-ceea-467a-9f2b-3c7d9a1b4e60?name=Ada%20Lovelace'
    const exchanges = [traceExchange({ requestId: 'a', url })]

    // Act
    render(<ExchangeList {...props({ exchanges })} />)

    // Assert
    expect(screen.getByText(url)).toBeDefined()
  })

  it('should render a status with its reason phrase', () => {
    // Arrange
    const exchanges = [traceExchange({ requestId: 'a', status: 404, statusText: 'Not Found' })]

    // Act
    render(<ExchangeList {...props({ exchanges })} />)

    // Assert
    expect(screen.getByText('404 Not Found')).toBeDefined()
  })

  it('should render an opaque response as opaque rather than as a zero status', () => {
    // Arrange — the sniffer reports 0 for an opaque CORS response or an abort.
    const exchanges = [traceExchange({ requestId: 'a', status: 0, statusText: '' })]

    // Act
    render(<ExchangeList {...props({ exchanges })} />)

    // Assert
    expect(screen.getByText('opaque')).toBeDefined()
  })

  it('should render a skipped body as skipped, with its size and reason', () => {
    // Arrange
    const exchanges = [
      traceExchange({
        requestId: 'a',
        body: {
          _tag: 'SkippedBody',
          contentType: 'video/mp4',
          size: 84_213_760,
          hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
          reason: 'over the size cap',
        },
      }),
    ]

    // Act
    render(<ExchangeList {...props({ exchanges })} />)

    // Assert — never an empty body; the trace is explicit about what it dropped
    expect(
      screen.getByText('video/mp4 · body not stored (84213760 bytes, over the size cap)')
    ).toBeDefined()
  })

  it('should report the exchange it was asked to open', async () => {
    // Arrange
    const onSelectExchange = vi.fn()
    const exchanges = [traceExchange({ requestId: 'a', url: 'https://portal.example.org/one' })]
    render(<ExchangeList {...props({ exchanges, onSelectExchange })} />)

    // Act
    await userEvent.click(screen.getByRole('button', { name: /portal\.example\.org\/one/ }))

    // Assert
    expect(onSelectExchange).toHaveBeenCalledWith(exchanges[0])
  })

  it('should narrow the rows as a URL is typed', async () => {
    // Arrange
    render(
      <ControlledExchangeList
        exchanges={[
          traceExchange({ requestId: 'a', url: 'https://portal.example.org/api/v2/patients' }),
          traceExchange({ requestId: 'b', url: 'https://portal.example.org/api/v2/observations' }),
        ]}
      />
    )

    // Act
    await userEvent.type(screen.getByLabelText('URL contains'), 'patients')

    // Assert
    expect(screen.getByText('https://portal.example.org/api/v2/patients')).toBeDefined()
    expect(screen.queryByText('https://portal.example.org/api/v2/observations')).toBeNull()
  })

  it('should narrow the rows to a response class', async () => {
    // Arrange
    render(
      <ControlledExchangeList
        exchanges={[
          traceExchange({ requestId: 'a', url: 'https://h/ok', status: 200 }),
          traceExchange({ requestId: 'b', url: 'https://h/missing', status: 404 }),
        ]}
      />
    )

    // Act
    await userEvent.selectOptions(screen.getByLabelText('Status'), '4xx')

    // Assert
    expect(screen.getByText('https://h/missing')).toBeDefined()
    expect(screen.queryByText('https://h/ok')).toBeNull()
  })

  it('should offer the content types actually present', () => {
    // Arrange
    const exchanges = [
      withContentType('a', 'application/json; charset=utf-8'),
      withContentType('b', 'text/html'),
    ]

    // Act
    render(<ExchangeList {...props({ exchanges })} />)

    // Assert
    const select = screen.getByLabelText('Content type')
    expect([...select.querySelectorAll('option')].map((option) => option.value)).toEqual([
      'all',
      'application/json',
      'text/html',
    ])
  })

  it('should keep the content-type choice recoverable after it has been made', async () => {
    // Arrange — options come from the unfiltered exchanges, so choosing one
    // must not collapse the select to that single choice.
    render(
      <ControlledExchangeList
        exchanges={[withContentType('a', 'application/json'), withContentType('b', 'text/html')]}
      />
    )

    // Act
    await userEvent.selectOptions(screen.getByLabelText('Content type'), 'application/json')

    // Assert
    const select = screen.getByLabelText('Content type')
    expect([...select.querySelectorAll('option')].map((option) => option.value)).toEqual([
      'all',
      'application/json',
      'text/html',
    ])
  })

  it('should distinguish an empty recording from one the filters emptied', async () => {
    // Arrange
    const { unmount } = render(<ExchangeList {...props({ exchanges: [] })} />)

    // Assert
    expect(screen.getByText('This recording has no exchanges.')).toBeDefined()
    unmount()

    // Act
    render(
      <ControlledExchangeList
        exchanges={[traceExchange({ requestId: 'a', url: 'https://h/one' })]}
      />
    )
    await userEvent.type(screen.getByLabelText('URL contains'), 'nothing-matches-this')

    // Assert
    expect(screen.getByText('No exchanges match these filters.')).toBeDefined()
  })
})

// Helpers

const withContentType = (requestId: string, contentType: string): TraceExchange =>
  traceExchange({
    requestId,
    url: `https://portal.example.org/${requestId}`,
    body: {
      _tag: 'StoredBody',
      contentType,
      data: '',
      size: 0,
      hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
    },
  })

/** Every prop at its resting value, so each test states only what it is about. */
const props = (
  overrides: Partial<Parameters<typeof ExchangeList>[0]>
): Parameters<typeof ExchangeList>[0] => ({
  exchanges: [],
  filters: NO_FILTERS,
  onFiltersChange: (): void => {},
  onSelectExchange: (): void => {},
  ...overrides,
})

/**
 * `ExchangeList` is fully controlled, so the filter interactions need an owner
 * for the state — the same wiring `RecordingsPanel` provides in production.
 */
const ControlledExchangeList = ({
  exchanges,
}: {
  readonly exchanges: readonly TraceExchange[]
}): JSX.Element => {
  const [filters, setFilters] = useState<ExchangeFilters>(NO_FILTERS)
  return (
    <ExchangeList
      exchanges={exchanges}
      filters={filters}
      onFiltersChange={setFilters}
      onSelectExchange={(): void => {}}
    />
  )
}
