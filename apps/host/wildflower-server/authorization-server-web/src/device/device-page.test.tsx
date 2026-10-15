import { HttpClient, HttpClientResponse } from '@effect/platform'
import type { HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer } from 'effect'
import { type JSX, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  OWNER_BROWSER_SESSION_HEADER,
  ownerBrowserSessionRunner,
} from '../owner-browser-session.ts'
import { DevicePage } from './device-page.tsx'

/**
 * The device page against a stub server: every request goes through the real
 * runner, client and decoders, over a transport that answers like the
 * authorization server does, so the tests see exactly what the page reads and
 * sends.
 */

const SERVER_ORIGIN = 'https://ruth.relay.example'

/**
 * A request the stub server saw: its method, path, JSON body, and the session
 * it asked the server for (`Wildflower-Session`).
 */
interface SeenRequest {
  readonly method: string
  readonly path: string
  readonly body: unknown
  readonly session: string | undefined
}

/** How the stub server answers one request, by method and path. */
type Answer = (request: SeenRequest) => { readonly status: number; readonly body: unknown }

let seen: SeenRequest[] = []
let answer: Answer = () => ({ status: 404, body: {} })

const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown =>
  request.body._tag === 'Uint8Array'
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : undefined

const stubServer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    const seenRequest: SeenRequest = {
      method: request.method,
      path: new URL(request.url).pathname,
      body: bodyOf(request),
      session: request.headers[OWNER_BROWSER_SESSION_HEADER.name.toLowerCase()],
    }
    seen.push(seenRequest)
    const { status, body } = answer(seenRequest)
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      )
    )
  })
)

/** The pending device request the stub server holds for `userCode`. */
const deviceConsentFor = (userCode: string): unknown => ({
  userCode,
  clientId: 'pebble-watch',
  clientName: 'Pebble Watch',
  deviceName: null,
  requestedScopes: ['system/Observation.rs'],
  allowedScopes: ['system/Observation.rs'],
})

/**
 * A stub server holding a pending request for `userCode` only, deciding it
 * with `decision`.
 */
const serverHolding =
  (userCode: string, decision: unknown): Answer =>
  (request) => {
    if (request.path === `/authorization/devices/${userCode}`) {
      return { status: 200, body: deviceConsentFor(userCode) }
    }
    if (request.path.startsWith(`/authorization/devices/${userCode}/`)) {
      return { status: 200, body: decision }
    }
    const unknownCode = /^\/authorization\/devices\/([^/]+)$/.exec(request.path)?.[1]
    if (unknownCode !== undefined) {
      return { status: 404, body: { error: 'DeviceConsentNotFound', userCode: unknownCode } }
    }
    return { status: 404, body: {} }
  }

beforeEach(() => {
  seen = []
  // jsdom has no scrollIntoView; the card scrolls its error banner into view.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
})

const renderPage = (
  initialUserCode: string
): { readonly user: ReturnType<typeof userEvent.setup> } => {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  render(
    <DevicePage
      initialUserCode={initialUserCode}
      runAuthed={ownerBrowserSessionRunner(SERVER_ORIGIN, stubServer)}
    />,
    { wrapper }
  )
  return { user: userEvent.setup({ delay: null }) }
}

/** The decisions (`approve` / `deny`) the stub server received. */
const decisions = (): readonly SeenRequest[] => seen.filter((request) => request.method === 'POST')

describe('DevicePage — the code', () => {
  test('the code from the link fills the box, and nothing is read until the Owner confirms it', async () => {
    answer = serverHolding('WDJB-MJHT', { status: 'approved' })
    const { user } = renderPage('wdjb-mjht')

    expect(screen.getByLabelText<HTMLInputElement>('Code').value).toBe('WDJB-MJHT')
    expect(seen).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Pebble Watch')).toBeDefined()
    expect(seen.map((request) => request.path)).toEqual(['/authorization/devices/WDJB-MJHT'])
  })

  test('an unknown code shows an error, and the Owner can enter another', async () => {
    answer = serverHolding('WDJB-MJHT', { status: 'approved' })
    const { user } = renderPage('BCDF-GHJK')

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'No device is waiting with this code.'
    )
    const codeBox = screen.getByLabelText('Code')
    await user.clear(codeBox)
    await user.type(codeBox, 'WDJB-MJHT')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Pebble Watch')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('DevicePage — deciding', () => {
  test('approving sends the scopes on the Owner browser session and says to return to the device', async () => {
    answer = serverHolding('WDJB-MJHT', { status: 'approved' })
    const { user } = renderPage('WDJB-MJHT')

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(await screen.findByRole('button', { name: 'Approve' }))

    expect(
      await screen.findByText('The device is approved. You can return to it now.')
    ).toBeDefined()
    expect(decisions()).toEqual([
      {
        method: 'POST',
        path: '/authorization/devices/WDJB-MJHT/approve',
        body: { approvedScopes: ['system/Observation.rs'] },
        session: OWNER_BROWSER_SESSION_HEADER.value,
      },
    ])
    expect(new Set(seen.map((request) => request.session))).toEqual(
      new Set([OWNER_BROWSER_SESSION_HEADER.value])
    )
  })

  test('declining denies the request and says so', async () => {
    answer = serverHolding('WDJB-MJHT', { status: 'denied' })
    const { user } = renderPage('WDJB-MJHT')

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(await screen.findByRole('button', { name: 'Decline' }))

    expect(await screen.findByText('The request was declined.')).toBeDefined()
    expect(decisions().map((request) => request.path)).toEqual([
      '/authorization/devices/WDJB-MJHT/deny',
    ])
  })
})

describe('DevicePage — a browser that cannot decide here', () => {
  test.each([
    ['not signed in', 401, {}],
    ['signed in without the scope', 403, { error: 'InsufficientScope', missingScopes: [] }],
  ])(
    '%s is told to approve on the server, and the request is left untouched',
    async (_case, status, body) => {
      answer = () => ({ status, body })
      const { user } = renderPage('WDJB-MJHT')

      await user.click(screen.getByRole('button', { name: 'Continue' }))

      expect(
        await screen.findByText('Approve this on the device running your server.')
      ).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
      expect(decisions()).toEqual([])
    }
  )
})
