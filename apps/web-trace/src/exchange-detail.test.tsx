import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vite-plus/test'
import { traceExchange } from 'web-trace-core/test-helpers'

import { ExchangeDetail } from './exchange-detail.tsx'

afterEach(() => {
  cleanup()
})

const noop = (): void => {}

describe('ExchangeDetail', () => {
  // A response may repeat a header name *and* its value. Keying the rows on the
  // pair alone collided, and React drops or mis-associates a duplicate-keyed
  // row — so the surface would under-report what the portal actually sent.
  test('renders every repeated header rather than collapsing the duplicates', () => {
    // Arrange
    const exchange = traceExchange({
      headers: [
        ['Vary', 'Accept-Encoding'],
        ['Vary', 'Accept-Encoding'],
      ],
    })

    // Act
    render(<ExchangeDetail exchange={exchange} onClose={noop} />)

    // Assert
    expect(screen.getAllByText('Vary')).toHaveLength(2)
    expect(screen.getAllByText('Accept-Encoding')).toHaveLength(2)
  })

  test('says so when nothing recorded a header', () => {
    render(<ExchangeDetail exchange={traceExchange({ headers: [] })} onClose={noop} />)
    expect(screen.getByText('No headers were recorded.')).toBeDefined()
  })
})
