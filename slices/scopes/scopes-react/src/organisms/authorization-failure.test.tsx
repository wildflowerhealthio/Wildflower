import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { AuthorizationFailure } from './authorization-failure.tsx'

afterEach(() => {
  cleanup()
})

describe('AuthorizationFailure', () => {
  it('names every missing scope by its canonical string', () => {
    render(<AuthorizationFailure missingScopes={['wildflower/Grant.d', 'system/*.rs']} />)
    expect(screen.getByText('wildflower/Grant.d')).toBeTruthy()
    expect(screen.getByText('system/*.rs')).toBeTruthy()
  })

  it('shows a friendly resource label for a resource scope', () => {
    // `wildflower/Grant.d` parses to the Grant admin resource, whose
    // `singularLabel()` is "Grant" — shown alongside the raw scope.
    render(<AuthorizationFailure missingScopes={['wildflower/Grant.d']} />)
    expect(screen.getByText('Grant')).toBeTruthy()
    expect(screen.getByText('wildflower/Grant.d')).toBeTruthy()
  })

  it('renders a generic message and no list when no scopes are named', () => {
    // The undeclared-403 path: detected but the body was never decoded.
    render(<AuthorizationFailure missingScopes={[]} />)
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('exposes the step-up hook only when onRequestAccess is supplied', async () => {
    const onRequestAccess = vi.fn()
    const { rerender } = render(<AuthorizationFailure missingScopes={['wildflower/Grant.d']} />)
    expect(screen.queryByRole('button', { name: /request access/i })).toBeNull()

    rerender(
      <AuthorizationFailure
        missingScopes={['wildflower/Grant.d']}
        onRequestAccess={onRequestAccess}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /request access/i }))
    expect(onRequestAccess).toHaveBeenCalledOnce()
  })

  it('renders every scope string for any list, without throwing', () => {
    // Unknown-shaped tokens (no `context/Resource.perms` structure) parse to
    // Unknown scopes, so each renders exactly once as its raw string — a stable
    // target for the property.
    const scopeArb = fc.integer({ min: 0, max: 1_000_000 }).map((n) => `scope-${n}`)
    fc.assert(
      fc.property(fc.uniqueArray(scopeArb, { minLength: 1, maxLength: 8 }), (missingScopes) => {
        render(<AuthorizationFailure missingScopes={missingScopes} />)
        for (const scope of missingScopes) {
          expect(screen.getByText(scope)).toBeTruthy()
        }
        cleanup()
      })
    )
  })
})
