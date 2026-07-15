import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { descriptors, type CollectorConfig } from 'collector-registry/registry'
import { defaultConfig } from 'fhir-r4-client-collector'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { AccountFormScreen } from './account-form.tsx'
import { configForms, configFormForTag } from './config-form.tsx'

afterEach(() => {
  cleanup()
})

/**
 * Mount `content` inside a minimal TanStack router so `AccountFormScreen`'s
 * `PageHeader` back `<Link>` resolves its `RouterContext`. No navigation is
 * exercised — the router exists only for link rendering.
 */
const renderWithRouter = (content: ReactNode): ReturnType<typeof render> => {
  const rootRoute = createRootRoute({ component: () => <>{content}</> })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

describe('config form registry', () => {
  test('every registered collector descriptor has a config form (backs the compile-time exhaustiveness lock)', () => {
    // The `Record<CollectorTag, …>` annotation on `configForms` makes a missing
    // form a *compile* error; this asserts the same total coverage at runtime,
    // and that the lookup helper is a view over the same map.
    for (const descriptor of descriptors) {
      expect(configForms[descriptor.tag]).toBeTypeOf('function')
      expect(configFormForTag(descriptor.tag)).toBe(configForms[descriptor.tag])
    }
  })
})

describe('AccountFormScreen', () => {
  test('renders the fhir-r4 form (type badge + fields) for its tag', async () => {
    renderWithRouter(
      <AccountFormScreen
        title="Add Account"
        tag="fhir-r4"
        initial={undefined}
        prefill={undefined}
        initialName=""
        disabled={false}
        error={null}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // RouterProvider mounts asynchronously — wait for the routed content.
    expect(await screen.findByText('FHIR R4')).toBeTruthy()
    expect(screen.getByLabelText('Root URL')).toBeTruthy()
    expect(screen.getByLabelText('Patient ID')).toBeTruthy()
  })

  test('defaults an empty account name to "<collector title> <date>" on submit', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<(name: string, config: CollectorConfig) => void>()
    renderWithRouter(
      <AccountFormScreen
        title="Add Account"
        tag="fhir-r4"
        initial={undefined}
        prefill={undefined}
        initialName=""
        disabled={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    )

    await user.click(await screen.findByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledOnce()
    const call = onSubmit.mock.calls[0]
    expect(call?.[0]).toMatch(/^FHIR R4 /)
    expect(call?.[1]).toEqual(defaultConfig)
  })

  test('keeps a provided account name and forwards the decoded config', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderWithRouter(
      <AccountFormScreen
        title="Edit Account"
        tag="fhir-r4"
        initial={defaultConfig}
        prefill={undefined}
        initialName="My FHIR Server"
        disabled={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    )

    await user.click(await screen.findByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('My FHIR Server', defaultConfig)
  })
})
