# React Testing Reference

Patterns and pitfalls for testing React components and hooks with Vitest and Testing Library.

## Environment Setup

Do NOT manually initialize JSDOM. Vitest is configured with `environment: 'jsdom'` which automatically provides DOM globals.

```typescript
// Avoid: Redundant JSDOM setup
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')

// Correct: Just import what you need
import { renderHook, act } from '@testing-library/react'
```

## Console Mocking

Suppress console noise in tests:

```typescript
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})
```

## Testing with waitFor

Do NOT wrap `waitFor` in `act()` — it handles `act()` internally. Double-wrapping causes timing issues.

```typescript
// Avoid: Double-wrapping
await act(async () => {
  await waitFor(() => {
    expect(screen.getByText('Content')).toBeDefined()
  })
})

// Correct
await waitFor(() => {
  expect(screen.getByText('Content')).toBeDefined()
})
```

## Mock Helper Factories

Create factories to reduce boilerplate for complex mocks:

```typescript
import { createMockPlatformContext, createMockHub } from '~/test-utils'

// Use the built-in createMockPlatformContext
vi.mocked(usePlatformContext).mockReturnValue(
  createMockPlatformContext({
    activeOrgStream: Stream.succeed(Either.right(mockOrg)),
    activeOrg: Effect.succeed(mockOrg),
    userOrgs: { 'test-org': 'admin' },
  })
)

// Or provide a custom hub mock
vi.mocked(usePlatformContext).mockReturnValue(
  createMockPlatformContext({
    hub: createMockHub({
      get: vi.fn(() => Effect.succeed(mockResource)),
      subscribe: vi.fn(() => Stream.succeed(Either.right(mockResource))),
    }),
  })
)
```

The `createMockHub` helper provides sensible defaults for all Hub methods. Override only what you need for your test.

## Testing Hooks with Effects

Wrap state transitions in `act()`:

```typescript
it('should resolve effect correctly', async () => {
  const { result, unmount } = renderHook(() => useEffectTs(Effect.succeed(42)))

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50))
  })

  await expect(result.current).resolves.toBe(42)
  unmount()
})
```

## Handling Promise Rejections

Catch promise rejections early to prevent unhandled rejection warnings:

```typescript
it('should reject with error', async () => {
  const error = new Error('test error')
  const { result, unmount } = renderHook(() => useEffectTs(Effect.fail(error)))

  // Catch early to prevent unhandled rejection warnings
  const errorPromise = result.current.catch((e) => e)

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50))
  })

  const caught = await errorPromise
  expect(caught).toBe(error)
  unmount()
})
```
