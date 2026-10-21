import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Effect, Layer } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { AUTHORIZATION_CLIENT_ID } from './config.ts'
import { buildRouterContext } from './router-context.ts'
import { buildRouter } from './router.ts'
import { buildSessionQueryClient } from './session-expiry.ts'
import type { ServerSession } from './sign-in.ts'

/**
 * The signed-in access pages, mounted through the real router and router
 * context over a stub transport that answers the authorization API and
 * records every request, so each test reads what went on the wire.
 */

beforeEach(() => {
  stubDialogModality()
})

afterEach(() => {
  cleanup()
  restoreDialogModality()
})

describe('the access page', () => {
  it('lists the approved apps by client name, from the server’s authorization API, with the session’s bearer', async () => {
    // Arrange
    const server = stubServer()

    // Act
    mountAccessPages(server)

    // Assert
    const approvedApps = await sectionTitled('Approved Apps')
    expect(await within(approvedApps).findByText(medicationsClient.name)).toBeTruthy()
    const grantsRead = server.requests.find(
      (request) => request.method === 'GET' && request.url.endsWith('/grants')
    )
    expect(grantsRead).toEqual({
      method: 'GET',
      url: 'https://ruth.wildflowerhealth.io/authorization/grants',
      authorization: 'Bearer tok_owner',
      body: undefined,
    })
  })

  it('lists the authorized devices, read only', async () => {
    // Arrange
    const server = stubServer()

    // Act
    mountAccessPages(server)

    // Assert
    const devices = await sectionTitled('Authorized Devices')
    expect(within(devices).getByText(pebbleGrant.deviceName)).toBeTruthy()
    expect(within(devices).queryByRole('button', { name: /Actions for/ })).toBeNull()
  })

  it('revokes a grant, then every token its client holds', async () => {
    // Arrange
    const server = stubServer()
    mountAccessPages(server)
    const approvedApps = await sectionTitled('Approved Apps')
    fireEvent.click(
      await within(approvedApps).findByRole('button', {
        name: `Actions for ${medicationsClient.name}`,
      })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke' }))

    // Act
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))

    // Assert
    await waitFor(() => {
      expect(server.writes()).toEqual([
        {
          method: 'DELETE',
          url: `https://ruth.wildflowerhealth.io/authorization/grants/${medicationsGrant.id}`,
          authorization: 'Bearer tok_owner',
          body: undefined,
        },
        {
          method: 'POST',
          url: 'https://ruth.wildflowerhealth.io/authorization/revocations',
          authorization: 'Bearer tok_owner',
          body: { subject: medicationsGrant.clientId },
        },
      ])
    })
  })

  it('disables a trusted app', async () => {
    // Arrange
    const server = stubServer()
    mountAccessPages(server)
    const trustedApps = await sectionTitled('Trusted Apps')
    fireEvent.click(
      await within(trustedApps).findByRole('button', {
        name: `Actions for ${medicationsClient.name}`,
      })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disable' }))

    // Act
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' }))

    // Assert — one PATCH of the client's `disabledAt`.
    await waitFor(() => {
      expect(server.writes().map(({ method, url }) => ({ method, url }))).toEqual([
        {
          method: 'PATCH',
          url: `https://ruth.wildflowerhealth.io/authorization/clients/${medicationsClient.clientId}`,
        },
      ])
    })
    const [patch] = server.writes()
    expect(patch?.authorization).toBe('Bearer tok_owner')
    const patchBody = patch?.body
    expect(
      typeof patchBody === 'object' && patchBody !== null ? Object.keys(patchBody) : []
    ).toEqual(['disabledAt'])
  })

  it('offers a Revoke for the host app’s grant, but no switch for its client', async () => {
    // Arrange
    const server = stubServer()

    // Act
    mountAccessPages(server)

    // Assert — the host app's grant has its actions; its trusted-app row has none.
    const approvedApps = await sectionTitled('Approved Apps')
    expect(
      await within(approvedApps).findByRole('button', { name: `Actions for ${hostClient.name}` })
    ).toBeTruthy()
    const trustedApps = await sectionTitled('Trusted Apps')
    expect(await within(trustedApps).findByText(hostClient.name)).toBeTruthy()
    expect(
      within(trustedApps).queryByRole('button', { name: `Actions for ${hostClient.name}` })
    ).toBeNull()
  })

  it('offers no Revoke for this app’s own grant', async () => {
    // Arrange
    const server = stubServer()

    // Act
    mountAccessPages(server)

    // Assert — listed by id (it isn't among the trusted apps here), no actions.
    const approvedApps = await sectionTitled('Approved Apps')
    await within(approvedApps).findByRole('button', {
      name: `Actions for ${medicationsClient.name}`,
    })
    expect(within(approvedApps).getByText(AUTHORIZATION_CLIENT_ID)).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: `Actions for ${AUTHORIZATION_CLIENT_ID}` })
    ).toBeNull()
  })

  it('lists the signed-in browsers, this one marked, an unnamed same-device session as the On-device browser and a paired one by its name', async () => {
    // Arrange
    const server = stubServer()

    // Act
    mountAccessPages(server)

    // Assert
    const browsers = await sectionTitled('Browsers')
    const rows = within(browsers).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    const [thisRow, otherRow, pairedRow] = rows
    expect(within(thisRow).getByText('On-device browser')).toBeTruthy()
    expect(within(thisRow).getByText('This browser')).toBeTruthy()
    expect(
      within(thisRow).getByText(/^On-device · Signed in .+ · Expires .+ · Last seen .+$/)
    ).toBeTruthy()
    expect(within(otherRow).getByText('On-device browser')).toBeTruthy()
    expect(within(otherRow).queryByText('This browser')).toBeNull()
    expect(within(pairedRow).getByText(pairedBrowserSession.name)).toBeTruthy()
    expect(within(pairedRow).getByText(/^Paired · Signed in /)).toBeTruthy()
    expect(
      server.requests.find((request) => request.url.endsWith('/authorization/browser-sessions'))
        ?.authorization
    ).toBe('Bearer tok_owner')
  })

  it('reads the browsers once for a page load', async () => {
    // Arrange — the app's own query client, with its staleTime.
    const server = stubServer()

    // Act
    mountAccessPages(server, buildSessionQueryClient(vi.fn()))
    await sectionTitled('Browsers')
    await sectionTitled('Approved Apps')

    // Assert
    expect(
      server.requests.filter((request) => request.url.endsWith('/authorization/browser-sessions'))
    ).toHaveLength(1)
  })

  it('revokes a browser’s session, then reads the list again', async () => {
    // Arrange
    const server = stubServer()
    mountAccessPages(server)
    const browsers = await sectionTitled('Browsers')
    const [, otherRow] = within(browsers).getAllByRole('listitem')
    fireEvent.click(within(otherRow).getByRole('button', { name: 'Actions for On-device browser' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke' }))
    const listReads = (): number =>
      server.requests.filter((request) => request.url.endsWith('/authorization/browser-sessions'))
        .length
    const readsBefore = listReads()

    // Act
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))

    // Assert
    await waitFor(() => {
      expect(server.writes()).toEqual([
        {
          method: 'DELETE',
          url: `https://ruth.wildflowerhealth.io/authorization/browser-sessions/${otherBrowserSession.sid}`,
          authorization: 'Bearer tok_owner',
          body: undefined,
        },
      ])
    })
    await waitFor(() => {
      expect(listReads()).toBeGreaterThan(readsBefore)
    })
  })

  it('takes a session that already ended as revoked, with no error', async () => {
    // Arrange — the session ended elsewhere: the revoke answers 404, and the
    // list read after it no longer holds the session.
    let otherSessionEnded = false
    const server = stubServer(
      undefined,
      () =>
        Response.json(
          otherSessionEnded
            ? [thisBrowserSession, pairedBrowserSession]
            : [thisBrowserSession, otherBrowserSession, pairedBrowserSession]
        ),
      () => {
        otherSessionEnded = true
        return Response.json(
          { error: 'BrowserSessionNotFound', sid: otherBrowserSession.sid },
          { status: 404 }
        )
      }
    )
    mountAccessPages(server)
    const browsers = await sectionTitled('Browsers')
    const [, otherRow] = within(browsers).getAllByRole('listitem')
    fireEvent.click(within(otherRow).getByRole('button', { name: 'Actions for On-device browser' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke' }))

    // Act
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))

    // Assert
    await waitFor(() => {
      expect(within(browsers).getAllByRole('listitem')).toHaveLength(2)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('still shows a failed revoke once the list is empty', async () => {
    // Arrange — the revoke fails, and the list read after it is empty.
    let revokeFailed = false
    const server = stubServer(
      undefined,
      () => Response.json(revokeFailed ? [] : [thisBrowserSession, otherBrowserSession]),
      () => {
        revokeFailed = true
        return new Response(null, { status: 500 })
      }
    )
    mountAccessPages(server)
    const browsers = await sectionTitled('Browsers')
    const [, otherRow] = within(browsers).getAllByRole('listitem')
    fireEvent.click(within(otherRow).getByRole('button', { name: 'Actions for On-device browser' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke' }))

    // Act
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))

    // Assert
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Browsers' })).toBeNull()
    })
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('offers a Revoke on this browser too, warning that it signs this browser out', async () => {
    // Arrange
    const server = stubServer()
    mountAccessPages(server)
    const browsers = await sectionTitled('Browsers')
    const [thisRow] = within(browsers).getAllByRole('listitem')

    // Act
    fireEvent.click(within(thisRow).getByRole('button', { name: 'Actions for On-device browser' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke' }))

    // Assert
    expect(within(screen.getByRole('dialog')).getByText(/^Revoke this browser\?/)).toBeTruthy()
  })

  it('still shows the rest of the page when the browsers can’t be read', async () => {
    // Arrange — a session without `wildflower/BrowserSession.r`.
    const server = stubServer(undefined, () =>
      Response.json(
        { error: 'InsufficientScope', missingScopes: ['wildflower/BrowserSession.r'] },
        { status: 403 }
      )
    )

    // Act
    mountAccessPages(server)

    // Assert
    expect(await screen.findByText('Error Loading Browsers')).toBeTruthy()
    expect(await sectionTitled('Approved Apps')).toBeTruthy()
  })

  it('signs in again once the bearer has expired', async () => {
    // Arrange — the server answers the grants read with a 401.
    const server = stubServer(() => new Response(null, { status: 401 }))
    const onSessionExpired = vi.fn()

    // Act
    mountAccessPages(server, buildSessionQueryClient(onSessionExpired))

    // Assert
    await waitFor(() => {
      expect(onSessionExpired).toHaveBeenCalled()
    })
  })

  it('opens a grant’s detail from its row', async () => {
    // Arrange
    const server = stubServer()
    const { router } = mountAccessPages(server)
    const approvedApps = await sectionTitled('Approved Apps')

    // Act
    fireEvent.click(await within(approvedApps).findByText(medicationsClient.name))

    // Assert — the detail, naming the client and giving its id, with `?iss=`
    // kept on the way.
    expect(await screen.findByRole('heading', { name: 'Approved App' })).toBeTruthy()
    expect(await screen.findByText(medicationsClient.name)).toBeTruthy()
    expect(screen.getByText(medicationsGrant.clientId)).toBeTruthy()
    expect(screen.getByText(medicationsGrant.redirectUri)).toBeTruthy()
    expect(router.state.location.search).toEqual({ iss: SERVER_URL })
  })

  it('changes the grant’s app’s session lifetime from its detail', async () => {
    // Arrange
    const server = stubServer()
    mountAccessPages(server)
    const approvedApps = await sectionTitled('Approved Apps')
    fireEvent.click(await within(approvedApps).findByText(medicationsClient.name))
    const sessionLifetime = await sectionTitled('Session lifetime')
    expect(
      within(sessionLifetime).getByText(/These limits belong to the app, so they cover every/)
    ).toBeTruthy()
    const save = within(sessionLifetime).getByRole('button', { name: 'Save' })
    expect(save).toHaveProperty('disabled', true)

    // Act
    fireEvent.change(within(sessionLifetime).getByLabelText('Sign out after unused for'), {
      target: { value: '1800' },
    })
    fireEvent.click(
      within(sessionLifetime).getByLabelText(
        'Sign out when the browser session that signed it in ends'
      )
    )
    fireEvent.click(save)

    // Assert — one PATCH of the client's whole refresh policy.
    await waitFor(() => {
      expect(server.writes()).toEqual([
        {
          method: 'PATCH',
          url: `https://ruth.wildflowerhealth.io/authorization/clients/${medicationsClient.clientId}`,
          authorization: 'Bearer tok_owner',
          body: {
            refreshPolicy: {
              idleTtlSeconds: 1800,
              maxTtlSeconds: 2592000,
              endsWithBrowserSession: true,
            },
          },
        },
      ])
    })
  })
})

// Helpers

const SERVER_URL = 'https://ruth.wildflowerhealth.io'

const session: ServerSession = {
  serverUrl: SERVER_URL,
  authorizationApiUrl: `${SERVER_URL}/authorization/`,
  accessToken: 'tok_owner',
  returnTo: undefined,
}

const medicationsGrant = {
  id: 'grant-medications',
  clientId: '9769f8b274370708d0d3ebb2e3e59b7c',
  scopes: ['system/MedicationRequest.rs'],
  grantType: 'authorization_code',
  redirectUri: 'https://medications.wildflowerhealth.io/',
  grantedAt: '2026-09-01T12:00:00.000Z',
  lastUsedAt: null,
  patient: null,
} as const

const hostGrant = {
  ...medicationsGrant,
  id: 'grant-host',
  clientId: 'c4e755b6a4c1abf2aae6d0d83f2545a5',
  redirectUri: 'https://ruth.wildflowerhealth.io/',
} as const

/** This app's own grant, from the sign-in the page is running on. */
const ownGrant = {
  ...medicationsGrant,
  id: 'grant-own',
  clientId: AUTHORIZATION_CLIENT_ID,
  redirectUri: 'https://authorization.wildflowerhealth.io/',
} as const

const pebbleGrant = {
  id: 'grant-pebble',
  clientId: '6847df97d54c31936d54ca1b36b3bb09',
  scopes: ['system/Observation.cu'],
  grantType: 'device_code',
  deviceName: "Ruth's Pebble",
  grantedAt: '2026-09-02T12:00:00.000Z',
  lastUsedAt: null,
  patient: null,
} as const

/** The browser session this page is signed in through. */
const thisBrowserSession = {
  sid: 'session-this',
  kind: 'same_device',
  name: null,
  createdAt: '2026-10-17T08:00:00.000Z',
  expiresAt: '2026-10-17T16:00:00.000Z',
  lastSeenAt: '2026-10-17T09:30:00.000Z',
  heldByCaller: true,
} as const

/** Another browser signed in as the Owner. */
const otherBrowserSession = {
  ...thisBrowserSession,
  sid: 'session-other',
  createdAt: '2026-10-17T07:00:00.000Z',
  heldByCaller: false,
} as const

/** A browser that paired, under the name it was given. */
const pairedBrowserSession = {
  ...otherBrowserSession,
  sid: 'session-paired',
  kind: 'paired',
  name: 'Kitchen tablet',
  createdAt: '2026-10-17T06:00:00.000Z',
} as const

const medicationsClient = {
  clientId: medicationsGrant.clientId,
  name: 'Medication Viewer',
  kind: 'public',
  redirectUris: ['https://medications.wildflowerhealth.io/'],
  allowedScopes: ['system/MedicationRequest.rs'],
  allowedGrantTypes: ['authorization_code'],
  registeredAt: '2026-01-15T09:30:00.000Z',
  disabledAt: null,
  essential: false,
  refreshPolicy: { idleTtlSeconds: 604800, maxTtlSeconds: 2592000, endsWithBrowserSession: false },
} as const

const hostClient = {
  ...medicationsClient,
  clientId: hostGrant.clientId,
  name: 'Wildflower Host',
  redirectUris: [],
  essential: true,
} as const

/** One request as the stub server saw it; `body` is the parsed JSON, if any. */
interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
  readonly body: unknown
}

interface StubServer {
  readonly transport: Layer.Layer<HttpClient.HttpClient>
  readonly requests: readonly RecordedRequest[]
  /** Every request that was not a read. */
  readonly writes: () => readonly RecordedRequest[]
}

/**
 * A server whose authorization API answers with the grants, clients and
 * browser sessions above.
 */
const stubServer = (
  answerGrants: () => Response = () =>
    Response.json([medicationsGrant, hostGrant, ownGrant, pebbleGrant]),
  answerBrowserSessions: () => Response = () =>
    Response.json([thisBrowserSession, otherBrowserSession, pairedBrowserSession]),
  answerRevokeBrowserSession: () => Response = () => new Response(null, { status: 204 })
): StubServer => {
  const requests: RecordedRequest[] = []
  const answer = (method: string, url: string): Response => {
    const path = new URL(url).pathname
    if (method === 'GET' && path === '/authorization/grants') {
      return answerGrants()
    }
    if (method === 'GET' && path === `/authorization/grants/${medicationsGrant.id}`) {
      return Response.json(medicationsGrant)
    }
    if (method === 'GET' && path === '/authorization/clients') {
      return Response.json([hostClient, medicationsClient])
    }
    if (method === 'GET' && path === '/authorization/browser-sessions') {
      return answerBrowserSessions()
    }
    if (method === 'DELETE' && path.startsWith('/authorization/browser-sessions/')) {
      return answerRevokeBrowserSession()
    }
    if (method === 'PATCH') {
      return Response.json({ ...medicationsClient, disabledAt: '2026-10-13T12:00:00.000Z' })
    }
    return new Response(null, { status: 204 })
  }
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers['authorization'],
        body:
          request.body._tag === 'Uint8Array'
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
      })
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, answer(request.method, request.url))
      )
    })
  )
  return {
    transport,
    requests,
    writes: () => requests.filter((request) => request.method !== 'GET'),
  }
}

/** The list titled `title`, once it has rendered. */
const sectionTitled = async (title: string): Promise<HTMLElement> => {
  const heading = await screen.findByRole('heading', { name: title })
  const section = heading.closest('section')
  if (section === null) throw new Error(`${title} is not a titled list`)
  return section
}

/** Mount the signed-in router at the app root, `?iss=` naming the server. */
const mountAccessPages = (
  server: StubServer,
  queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
): { readonly router: ReturnType<typeof buildRouter> } => {
  const router = buildRouter({
    history: createMemoryHistory({
      initialEntries: [`/?iss=${encodeURIComponent(SERVER_URL)}`],
    }),
    basepath: '/',
    context: buildRouterContext(session, server.transport, queryClient),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { router }
}

/**
 * jsdom has no native `<dialog>`; model `showModal`/`close` as the `open`
 * attribute, as `authorization-react`'s own tests do, and restore the original
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
