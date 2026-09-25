import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Schema } from 'effect'
import { AccessManagement } from 'gatekeeper-core/http-api-definition'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { CLIENTS_QUERY_KEY } from '../queries/index.ts'
import { TrustedAppsSection } from './TrustedAppsSection.tsx'

/**
 * The "Trusted Apps" section on the Access index: one row per registered
 * client, with Disable (behind a confirm dialog) while trusted, Enable while
 * disabled (or scheduled to be), and no switch at all on the first-party host. The transport is
 * stubbed at `runAuthed` (read through the mocked router context), so a
 * confirmed switch is observable as a resolved call plus the list invalidation.
 */

const runAuthedStub = vi.fn((_effect: unknown) => Promise.resolve(undefined))

vi.mock('@tanstack/react-router', () => ({
  useRouteContext: ({
    select,
  }: {
    select: (context: { runAuthed: unknown }) => unknown
  }): unknown => select({ runAuthed: runAuthedStub }),
}))

beforeEach(() => {
  stubDialogModality()
})

afterEach(() => {
  cleanup()
  restoreDialogModality()
  vi.restoreAllMocks()
  runAuthedStub.mockClear()
})

describe('TrustedAppsSection', () => {
  it('should list every client by name, marking the disabled ones', () => {
    // Arrange
    const clients = [host, ohifViewer, disabledImporter]

    // Act
    renderSection(clients)

    // Assert
    expect(screen.getByText('Trusted Apps')).toBeTruthy()
    expect(screen.getByText('Wildflower')).toBeTruthy()
    expect(screen.getByText('OHIF Viewer')).toBeTruthy()
    expect(screen.getByText('Importer')).toBeTruthy()
    expect(screen.getAllByText('Disabled')).toHaveLength(1)
  })

  it('should not mark an app disabled while its disable is still scheduled', () => {
    // Arrange / Act
    renderSection([scheduledImporter])

    // Assert
    expect(screen.queryByText('Disabled')).toBeNull()
    expect(screen.getByText(/^wildflower-importer · Disables /)).toBeTruthy()
  })

  it('should render nothing when there are no clients', () => {
    // Arrange / Act
    renderSection([])

    // Assert
    expect(screen.queryByText('Trusted Apps')).toBeNull()
  })

  it('should offer no actions for the first-party host', () => {
    // Arrange / Act
    renderSection([host])

    // Assert
    expect(screen.queryByRole('button', { name: 'Actions for Wildflower' })).toBeNull()
  })

  it('should ask for confirmation before disabling, and send nothing until confirmed', () => {
    // Arrange
    renderSection([ohifViewer])

    // Act
    chooseAction('OHIF Viewer', 'Disable')

    // Assert
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Disable "OHIF Viewer"\?/)).toBeTruthy()
    expect(runAuthedStub).not.toHaveBeenCalled()
  })

  it('should disable the app once confirmed and refresh the list', async () => {
    // Arrange
    const { queryClient } = renderSection([ohifViewer])
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    chooseAction('OHIF Viewer', 'Disable')

    // Act
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' }))

    // Assert
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: CLIENTS_QUERY_KEY })
    })
    expect(runAuthedStub).toHaveBeenCalledTimes(1)
  })

  it('should not disable the app when the confirmation is cancelled', () => {
    // Arrange
    renderSection([ohifViewer])
    chooseAction('OHIF Viewer', 'Disable')

    // Act
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    // Assert
    expect(runAuthedStub).not.toHaveBeenCalled()
  })

  it('should block every switch while a request is in flight', async () => {
    // Arrange
    runAuthedStub.mockImplementationOnce(() => new Promise(() => undefined))
    renderSection([ohifViewer, disabledImporter])

    // Act
    chooseAction('Importer', 'Enable')
    fireEvent.click(screen.getByRole('button', { name: 'Actions for OHIF Viewer' }))

    // Assert
    await vi.waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Disable' }).hasAttribute('disabled')).toBe(true)
    })
  })

  it('should surface a failed switch in the error banner', async () => {
    // Arrange
    runAuthedStub.mockImplementationOnce(() => Promise.reject(new Error('Gatekeeper unavailable')))
    renderSection([disabledImporter])

    // Act
    chooseAction('Importer', 'Enable')

    // Assert
    expect((await screen.findAllByText(/Gatekeeper unavailable/)).length).toBeGreaterThan(0)
  })

  it('should re-enable a disabled app straight away', async () => {
    // Arrange
    const { queryClient } = renderSection([disabledImporter])
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
/** Scheduled far enough out that the wall clock the section reads never reaches it. */
const scheduledImporter = decodeClient({
  ...clientBody,
  clientId: 'wildflower-importer',
  name: 'Importer',
  disabledAt: '2999-01-01T00:00:00.000Z',
})

const renderSection = (
  clients: readonly AccessManagementClient[]
): { readonly queryClient: QueryClient } => {
  const queryClient = new QueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <TrustedAppsSection clients={clients} />
    </QueryClientProvider>
  )
  return { queryClient }
}

type AccessManagementClient = Schema.Schema.Type<typeof AccessManagement.ClientSchema>

/** Open a row's actions menu and pick one of its items. */
const chooseAction = (clientName: string, label: string): void => {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${clientName}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

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
