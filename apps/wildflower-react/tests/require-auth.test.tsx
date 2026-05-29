import { cleanup, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

/**
 * `RequireAuth` is a pure UI gate: it reads the live bearer token off
 * `<AuthTokenProvider>` (via `useAuthTokenSubscribable` →
 * `useStreamWithDefault`) and renders `<NeedsAuthMessage>` when the token
 * is absent (`null` or `''`), otherwise its `children`.
 *
 * Two dependencies are mocked so the test exercises only the gating
 * decision — not the machinery behind it:
 *
 *  - `react-kitchen-sink` — `useStreamWithDefault` is reduced to a stub
 *    that returns a test-controlled token directly, bypassing the real
 *    Effect `Stream` subscription (which would pull in scopes, fibers and
 *    a live `<AuthTokenProvider>`). `useAuthTokenSubscribable` returns a
 *    benign object whose `changes` field satisfies `RequireAuth`'s
 *    destructure; the stub `useStreamWithDefault` ignores the stream, so
 *    its exact shape is irrelevant.
 *  - `gatekeeper-react` — the real `NeedsAuthMessage` boots the RFC 8628
 *    device-authorization flow in a `useEffect` (Effect fiber + real
 *    network I/O via the gatekeeper client layer). That's the
 *    "unauthenticated" branch's noise, not the thing under test, so it's
 *    mocked to a recognizable static marker. Asserting on the marker tells
 *    us the gate chose the unauthenticated branch without dragging the
 *    OAuth flow (and its timers/network) into the test.
 *
 * The factory below uses `vi.hoisted` because `vi.mock` is hoisted above
 * the file's imports: the shared mutable `tokenHolder` must exist before
 * the mock factory closes over it. Each test sets `tokenHolder.value`
 * before rendering to drive the gate into a specific branch.
 */
const { tokenHolder } = vi.hoisted(() => ({
  tokenHolder: { value: null as string | null },
}))

vi.mock('react-kitchen-sink', () => ({
  // `RequireAuth` destructures `{ changes }`; the stub `useStreamWithDefault`
  // ignores the stream, so a placeholder satisfies the type at runtime.
  useAuthTokenSubscribable: () => ({ changes: null }),
  useStreamWithDefault: () => tokenHolder.value,
}))

vi.mock('gatekeeper-react', () => ({
  NeedsAuthMessage: (): JSX.Element => <div data-testid="needs-auth">needs auth</div>,
}))

// Imported AFTER the `vi.mock` calls so the mocks intercept `RequireAuth`'s
// transitive imports. (Vitest hoists `vi.mock` above this line at compile
// time, so the static import order here is only for human readers.)
const { RequireAuth } = await import('../src/session/require-auth.tsx')

const Child = (): JSX.Element => <div data-testid="child">protected content</div>

const renderGate = (): void => {
  render(
    <RequireAuth>
      <Child />
    </RequireAuth>
  )
}

describe('RequireAuth', () => {
  beforeEach(() => {
    tokenHolder.value = null
  })

  afterEach(() => {
    cleanup()
  })

  test('renders NeedsAuthMessage and hides children when the token is null', () => {
    // Arrange
    tokenHolder.value = null

    // Act
    renderGate()

    // Assert
    expect(screen.getByTestId('needs-auth')).toBeDefined()
    expect(screen.queryByTestId('child')).toBeNull()
  })

  test('renders NeedsAuthMessage and hides children when the token is empty string', () => {
    // Arrange
    tokenHolder.value = ''

    // Act
    renderGate()

    // Assert
    expect(screen.getByTestId('needs-auth')).toBeDefined()
    expect(screen.queryByTestId('child')).toBeNull()
  })

  test('renders children and hides NeedsAuthMessage when a non-empty token is present', () => {
    // Arrange
    tokenHolder.value = 'a-valid-bearer-token'

    // Act
    renderGate()

    // Assert
    expect(screen.getByTestId('child')).toBeDefined()
    expect(screen.queryByTestId('needs-auth')).toBeNull()
  })
})
