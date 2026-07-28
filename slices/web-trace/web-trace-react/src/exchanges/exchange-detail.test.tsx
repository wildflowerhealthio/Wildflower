import { cleanup, render, screen, within } from '@testing-library/react'
import { Duration, Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { traceExchange } from 'web-trace-core/test-helpers'

import { ExchangeDetail } from './exchange-detail.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ExchangeDetail', () => {
  it('should render the captured request URL exactly as recorded, unredacted', () => {
    // Arrange — an identifier in the path and a name in the query are exactly
    // what the export flow pseudonymizes. The viewer shows the user their own
    // data on their own device, so it shows them verbatim.
    const url =
      'https://portal.example.org/api/v2/patients/8f14e45f-ceea-467a-9f2b-3c7d9a1b4e60?name=Ada%20Lovelace'

    // Act
    render(<ExchangeDetail exchange={traceExchange({ url })} />)

    // Assert
    expect(screen.getByText(url)).toBeDefined()
  })

  it('should render every response header raw, including a Set-Cookie', () => {
    // Arrange
    const exchange = traceExchange({
      headers: [
        ['Content-Type', 'application/json'],
        ['Set-Cookie', 'session=8f14e45fceea467a; Path=/; HttpOnly'],
        ['Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5ZjMifQ.sig'],
      ],
    })

    // Act
    render(<ExchangeDetail exchange={exchange} />)

    // Assert — a collector author needs the auth mechanism as it actually is
    const headers = screen.getByLabelText('Response headers')
    expect(within(headers).getByText('session=8f14e45fceea467a; Path=/; HttpOnly')).toBeDefined()
    expect(
      within(headers).getByText('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5ZjMifQ.sig')
    ).toBeDefined()
  })

  it('should render repeated header names as separate rows', () => {
    // Arrange — a response may legitimately carry several Set-Cookie headers.
    const exchange = traceExchange({
      headers: [
        ['Set-Cookie', 'a=1'],
        ['Set-Cookie', 'b=2'],
      ],
    })

    // Act
    render(<ExchangeDetail exchange={exchange} />)

    // Assert
    const headers = screen.getByLabelText('Response headers')
    expect(within(headers).getAllByText('Set-Cookie')).toHaveLength(2)
    expect(within(headers).getByText('a=1')).toBeDefined()
    expect(within(headers).getByText('b=2')).toBeDefined()
  })

  it('should say when no response headers were recorded', () => {
    // Act
    render(<ExchangeDetail exchange={traceExchange({ headers: [] })} />)

    // Assert
    expect(screen.getByText('No response headers recorded.')).toBeDefined()
  })

  it('should render the response body', () => {
    // Arrange
    const exchange = traceExchange({
      body: {
        _tag: 'StoredBody',
        contentType: 'application/json',
        data: encodeBase64('{"status":"active"}'),
        size: 19,
        hash: HASH,
      },
    })

    // Act
    render(<ExchangeDetail exchange={exchange} />)

    // Assert
    expect(screen.getByText('{\n  "status": "active"\n}', EXACT_TEXT)).toBeDefined()
  })

  it('should report measured timings and name the unmeasured ones', () => {
    // Arrange
    const exchange = traceExchange({ timings: { wait: Duration.millis(120), receive: null } })

    // Act
    render(<ExchangeDetail exchange={exchange} />)

    // Assert — an unmeasured timing says so rather than reading as zero
    expect(screen.getByText('Wait 120 ms · receive not measured')).toBeDefined()
  })

  it('should render an opaque response as opaque rather than as a zero status', () => {
    // Act — the sniffer reports 0 for an opaque CORS response or an abort
    render(<ExchangeDetail exchange={traceExchange({ status: 0, statusText: '' })} />)

    // Assert
    expect(screen.getByText('opaque')).toBeDefined()
  })

  it('should state that the request side was never observed', () => {
    // Act
    render(<ExchangeDetail exchange={traceExchange({})} />)

    // Assert — a trace never claims to know what the sniffer did not see
    expect(
      screen.getByText(
        'The sniffer records no request method, request headers, or request body, so this trace cannot tell a GET from a POST to the same URL.'
      )
    ).toBeDefined()
  })
})

// Helpers

const HASH = 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o='

const encodeBase64 = Schema.encodeSync(Schema.StringFromBase64)

/**
 * Queries text without whitespace normalisation, which would otherwise erase the
 * indentation the body assertion exists to check.
 */
const EXACT_TEXT = { normalizer: (text: string): string => text }
