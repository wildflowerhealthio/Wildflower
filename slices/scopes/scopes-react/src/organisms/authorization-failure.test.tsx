import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { AuthorizationFailure } from './authorization-failure.tsx'

afterEach(() => {
  cleanup()
})

describe('AuthorizationFailure', () => {
  it('reads each resource scope as a plain-language phrase', () => {
    // `wildflower/Accounts.r` → "read Accounts" (verb from `permission.label()`,
    // record type from `resource.pluralLabel()`); `wildflower/Grant.cd` folds the
    // two verbs the same way the scope form's statements do.
    render(
      <AuthorizationFailure missingScopes={['wildflower/Accounts.r', 'wildflower/Grant.cd']} />
    )
    expect(screen.getByText('read Accounts')).toBeTruthy()
    expect(screen.getByText('create and delete Grants')).toBeTruthy()
  })

  it('keeps the canonical scope available on a hover tooltip', () => {
    // The raw `context/Resource.perms` string is demoted to the row's `title`, so
    // it never fronts as the primary text but stays reachable.
    render(<AuthorizationFailure missingScopes={['wildflower/Grant.d']} />)
    expect(screen.getByText('delete Grants')).toBeTruthy()
    expect(screen.getByTitle('wildflower/Grant.d')).toBeTruthy()
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
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
