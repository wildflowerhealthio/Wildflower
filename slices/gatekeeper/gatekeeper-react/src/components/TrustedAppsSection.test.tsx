import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Schema } from 'effect'
import { AccessManagement } from 'gatekeeper-core/http-api-definition'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { CLIENTS_QUERY_KEY } from '../queries/index.ts'
import { TrustedAppsList, TrustedAppsSection } from './TrustedAppsSection.tsx'

/**
 * The "Trusted Apps" section on the Access index: one row per registered
 * client, with Disable (behind a confirm dialog) while trusted, Enable while
 * disabled, and no switch at all on the first-party host. The transport is
 * stubbed at `runAuthed` (read through the mocked router context), so a
 * confirmed switch is observable as a resolved call plus the list invalidation.
 */

const runAuthedStub = vi.fn((_effect: unknown): Promise<unknown> => Promise.resolve(undefined))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useRouteContext: ({
      select,
    }: {
      select: (context: { runAuthed: unknown }) => unknown
    }): unknown => select({ runAuthed: runAuthedStub }),
  }
})

beforeEach(() => {
  stubDialogModality()
})

afterEach(() => {
  cleanup()
  restoreDialogModality()
  vi.restoreAllMocks()
  runAuthedStub.mockReset()
  runAuthedStub.mockImplementation(() => Promise.resolve(undefined))
})

describe('TrustedAppsSection', () => {
  it('should load the clients itself and list them', async () => {
    // Arrange
    runAuthedStub.mockResolvedValueOnce([ohifViewer])

    // Act
    renderWithQueryClient(<TrustedAppsSection />)

    // Assert
    expect(await screen.findByText('OHIF Viewer')).toBeTruthy()
  })

  it('should show a failed load in place, and list the clients after Retry', async () => {
    // Arrange — e.g. a session without `wildflower/Client.r`.
    runAuthedStub
      .mockRejectedValueOnce(new Error('Insufficient scope: wildflower/Client.r'))
      .mockResolvedValueOnce([ohifViewer])
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderWithQueryClient(<TrustedAppsSection />)
    expect(await screen.findByText('Error Loading Trusted Apps')).toBeTruthy()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    // Assert
    expect(await screen.findByText('OHIF Viewer')).toBeTruthy()
    expect(screen.queryByText('Error Loading Trusted Apps')).toBeNull()
  })
})

describe('TrustedAppsList', () => {
  it('should list every client by name, marking the disabled ones', () => {
    // Arrange
    const clients = [host, ohifViewer, disabledImporter]

    // Act
    renderList(clients)

    // Assert
    expect(screen.getByText('Trusted Apps')).toBeTruthy()
    expect(screen.getByText('Wildflower')).toBeTruthy()
    expect(screen.getByText('OHIF Viewer')).toBeTruthy()
    expect(screen.getByText('Importer')).toBeTruthy()
    expect(screen.getAllByText('Disabled')).toHaveLength(1)
  })

  it('should render nothing when there are no clients', () => {
    // Arrange / Act
    renderList([])

    // Assert
    expect(screen.queryByText('Trusted Apps')).toBeNull()
  })

  it('should offer no actions for the first-party host', () => {
    // Arrange / Act
    renderList([host])

    // Assert
    expect(screen.queryByRole('button', { name: 'Actions for Wildflower' })).toBeNull()
  })

  it('should ask for confirmation before disabling, and send nothing until confirmed', () => {
    // Arrange
    renderList([ohifViewer])

    // Act
    chooseAction('OHIF Viewer', 'Disable')

    // Assert
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Disable "OHIF Viewer"\?/)).toBeTruthy()
    expect(runAuthedStub).not.toHaveBeenCalled()
  })

  it('should disable the app once confirmed, close the dialog and refresh the list', async () => {
    // Arrange
    const { queryClient } = renderList([ohifViewer])
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    chooseAction('OHIF Viewer', 'Disable')

    // Act
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' }))

    // Assert
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: CLIENTS_QUERY_KEY })
    })
    expect(runAuthedStub).toHaveBeenCalledTimes(1)
    expect(isDialogOpen()).toBe(false)
  })

  it('should not disable the app when the confirmation is cancelled', () => {
    // Arrange
    renderList([ohifViewer])
    chooseAction('OHIF Viewer', 'Disable')

    // Act
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    // Assert
    expect(runAuthedStub).not.toHaveBeenCalled()
  })

  it('should block every switch while a request is in flight', async () => {
    // Arrange
    runAuthedStub.mockImplementationOnce(() => new Promise(() => undefined))
    renderList([ohifViewer, disabledImporter])

    // Act
    chooseAction('Importer', 'Enable')
    fireEvent.click(screen.getByRole('button', { name: 'Actions for OHIF Viewer' }))

    // Assert
    await vi.waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Disable' }).hasAttribute('disabled')).toBe(true)
    })
  })

  it('should send one disable however often the confirmation is clicked while it is in flight', async () => {
    // Arrange
    runAuthedStub.mockImplementationOnce(() => new Promise(() => undefined))
    renderList([ohifViewer])
    chooseAction('OHIF Viewer', 'Disable')
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' })

    // Act
    fireEvent.click(confirm)
    await vi.waitFor(() => {
      expect(confirm.hasAttribute('disabled')).toBe(true)
    })
    fireEvent.click(confirm)

    // Assert
    expect(runAuthedStub).toHaveBeenCalledTimes(1)
  })

  it('should close the dialog on a failed disable and surface the failure in the banner', async () => {
    // Arrange
    runAuthedStub.mockImplementationOnce(() => Promise.reject(new Error('Gatekeeper unavailable')))
    renderList([ohifViewer])
    chooseAction('OHIF Viewer', 'Disable')

    // Act
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' }))

    // Assert
    expect((await screen.findAllByText(/Gatekeeper unavailable/)).length).toBeGreaterThan(0)
    expect(isDialogOpen()).toBe(false)
  })

  it('should surface a failed enable in the error banner', async () => {
    // Arrange
    runAuthedStub.mockImplementationOnce(() => Promise.reject(new Error('Gatekeeper unavailable')))
    renderList([disabledImporter])

    // Act
    chooseAction('Importer', 'Enable')

    // Assert
    expect((await screen.findAllByText(/Gatekeeper unavailable/)).length).toBeGreaterThan(0)
  })

  it('should re-enable a disabled app straight away', async () => {
    // Arrange
    const { queryClient } = renderList([disabledImporter])
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    // Act
    chooseAction('Importer', 'Enable')

    // Assert
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: CLIENTS_QUERY_KEY })
    })
    expect(runAuthedStub).toHaveBeenCalledTimes(1)
  })
})

// Helpers

const decodeClient = Schema.decodeUnknownSync(AccessManagement.ClientSchema)

const clientBody = {
  kind: 'public',
  redirectUris: ['/'],
  allowedScopes: ['openid', 'patient/*.rs'],
  allowedGrantTypes: ['authorization_code', 'refresh_token'],
  registeredAt: '2026-01-15T09:30:00.000Z',
  disabledAt: null,
  firstParty: false,
}

const host = decodeClient({
  ...clientBody,
  clientId: 'wildflower-host',
  name: 'Wildflower',
  firstParty: true,
})
const ohifViewer = decodeClient({ ...clientBody, clientId: 'ohif-viewer', name: 'OHIF Viewer' })
const disabledImporter = decodeClient({
  ...clientBody,
  clientId: 'wildflower-importer',
  name: 'Importer',
  disabledAt: '2026-09-01T12:00:00.000Z',
})

/** Render under a fresh `QueryClient` that doesn't retry, so a failure shows at once. */
const renderWithQueryClient = (ui: JSX.Element): { readonly queryClient: QueryClient } => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
  return { queryClient }
}

const renderList = (
  clients: readonly AccessManagementClient[]
): { readonly queryClient: QueryClient } =>
  renderWithQueryClient(<TrustedAppsList clients={clients} />)

type AccessManagementClient = Schema.Schema.Type<typeof AccessManagement.ClientSchema>

/** Open a row's actions menu and pick one of its items. */
const chooseAction = (clientName: string, label: string): void => {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${clientName}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

const isDialogOpen = (): boolean => document.querySelector('dialog')?.hasAttribute('open') ?? false

/**
 * jsdom has no native `<dialog>`; model `showModal`/`close` as the `open`
 * attribute (as react-tundraish's own Dialog tests do), and restore the original
 * descriptors afterwards so the patch can't leak into other files.
 */
const dialogMethods = ['showModal', 'close'] as const
const originalDialogDescriptors = dialogMethods.map(
  (key) => [key, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key)] as const
)

const stubDialogModality = (): void => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
}

const restoreDialogModality = (): void => {
  for (const [key, descriptor] of originalDialogDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, key)
    else Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
  }
}
