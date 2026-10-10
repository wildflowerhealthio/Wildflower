import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

// `new.tsx` calls `createFileRoute(...)` at import and its `PageHeader` back link
// renders a TanStack `<Link>`; stub both so the body renders without a
// `RouterProvider`.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createFileRoute: () => (config: unknown) => config,
    useNavigate: () => (): void => undefined,
    Link: ({ to, children }: { to?: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  }
})

// The create body reads the create mutation from `queries.ts`; stub it so
// the tests assert the payload it posts and that `onCreated` is wired to the
// mutation's success callback.
const { createStub } = vi.hoisted(() => ({
  createStub: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as Error | null },
}))

vi.mock('../../../queries.ts', () => ({
  useAppCreateMutation: () => createStub,
}))

import { NewAppBody } from './new.tsx'

const noop = (): void => {}

describe('<NewAppBody>', () => {
  beforeEach(() => {
    createStub.mutate.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  test('posts name/url/requiresTunnel', () => {
    const onCreated = vi.fn()
    render(<NewAppBody onCreated={onCreated} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My App' } })
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://example.com/launch' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(createStub.mutate).toHaveBeenCalledTimes(1)
    expect(createStub.mutate.mock.calls[0]?.[0]).toEqual({
      name: 'My App',
      url: 'https://example.com/launch',
      requiresTunnel: false,
    })
    // `onCreated` rides the mutation's success callback (the route navigates back).
    expect(createStub.mutate.mock.calls[0]?.[1]).toMatchObject({ onSuccess: onCreated })
  })

  test('does not submit when a required field is blank', () => {
    render(<NewAppBody onCreated={noop} />)

    // Name filled, URL left blank.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My App' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(createStub.mutate).not.toHaveBeenCalled()
  })
})
