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

// The create body reads the two create mutations from `queries.ts`; stub them so
// the tests assert the payloads each arm posts and that `onCreated` is wired to
// the mutation's success callback.
const { createStub, selfHostedStub } = vi.hoisted(() => ({
  createStub: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as Error | null },
  selfHostedStub: {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null as Error | null,
  },
}))

vi.mock('../../../queries.ts', () => ({
  useAppsAdminCreateMutation: () => createStub,
  useSelfHostedAppCreateMutation: () => selfHostedStub,
  // Imported transitively by `-forms.tsx` (CloudAppFields) but unused here.
  useAppsAdminReplaceMutation: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
}))

import { NewAppBody } from './new.tsx'

const noop = (): void => {}

describe('<NewAppBody>', () => {
  beforeEach(() => {
    createStub.mutate.mockClear()
    selfHostedStub.mutate.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  test('defaults to the cloud arm and posts name/url/requiresTunnel', () => {
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

  test('does not submit the cloud arm when a required field is blank', () => {
    render(<NewAppBody onCreated={noop} />)

    // Name filled, URL left blank.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My App' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(createStub.mutate).not.toHaveBeenCalled()
  })

  test('switching to the self-hosted arm posts the picked bundle', () => {
    const onCreated = vi.fn()
    render(<NewAppBody onCreated={onCreated} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Self-hosted' }))

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Uploaded App' } })
    fireEvent.change(screen.getByLabelText('Subtitle'), { target: { value: 'My uploaded app' } })
    const file = new File(['zip-bytes'], 'app.zip', { type: 'application/zip' })
    fireEvent.change(screen.getByLabelText('Bundle (.zip)'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(selfHostedStub.mutate).toHaveBeenCalledTimes(1)
    expect(selfHostedStub.mutate.mock.calls[0]?.[0]).toEqual({
      name: 'Uploaded App',
      bundle: file,
      subtitle: 'My uploaded app',
    })
    expect(selfHostedStub.mutate.mock.calls[0]?.[1]).toMatchObject({ onSuccess: onCreated })
  })

  test('the mode switch toggles which create form is shown', () => {
    render(<NewAppBody onCreated={noop} />)

    // Cloud arm by default.
    expect(screen.getByRole('button', { name: 'Add' })).toBeDefined()

    fireEvent.click(screen.getByRole('tab', { name: 'Self-hosted' }))

    expect(screen.getByRole('button', { name: 'Add' })).toBeDefined()
  })
})
